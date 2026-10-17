import type { WordToken } from "./tokens.js";
import { afterSkippedDashes, DECLARE, NAMEREF_DECLARERS, WRITER_SPECS, writerSpec } from "./writer-specs.js";
import type { WriterSpec } from "./writer-specs.js";

/** Every builtin the table reads. */
export const WRITERS: ReadonlySet<string> = new Set([...Object.keys(WRITER_SPECS), "for", "select", "getopts"]);

/** Builtins that read DECLARE's options, whose `-i` makes later writes to the name arithmetic. */
export const DECLARERS: ReadonlySet<string> = new Set(Object.keys(WRITER_SPECS).filter((name) => WRITER_SPECS[name] === DECLARE));

export { NAMEREF_DECLARERS };

/**
 * The words a command reads as names it writes, or the text of an option word the table cannot read, which the
 * caller fails closed on. A command the table does not know writes no name. Attached option values and
 * zparseopts arrays come back as words sliced to the name, with their refs and cuts moved along.
 */
export function nameSlots(name: string, words: WordToken[]): WordToken[] | string {
  const args = afterSkippedDashes(name, words);
  if (name === "for" || name === "select") return forNames(args);
  if (name === "getopts") return args.slice(1, 2);
  const spec = writerSpec(name);
  return spec ? specSlots(spec, args) : [];
}

/** zsh takes several names before `in`, or before a parenthesised list, which the lexer leaves out of `args`. */
function forNames(args: WordToken[]): WordToken[] {
  const end = args.findIndex((a) => !a.quoted && a.value === "in");
  return end < 0 ? args : args.slice(0, end);
}

function specSlots(spec: WriterSpec, args: WordToken[]): WordToken[] | string {
  const slots: WordToken[] = [];
  let i = 0;
  for (let word = args[i]; word !== undefined && mayBeOption(word, spec); word = args[i]) {
    if (word.value === "--" || word.value === "-") {
      i++;
      break;
    }
    if (spec.longOptions === true && word.value.startsWith("--")) {
      i++;
      continue;
    }
    const read = readOption(word, args[i + 1], spec);
    if (read === null) return word.value;
    slots.push(...read.slots);
    i += read.width;
  }
  return [...slots, ...operandSlots(spec, args.slice(i))];
}

/** A dynamic word that opens with an expansion may expand to an option. */
function mayBeOption(word: WordToken, spec: WriterSpec): boolean {
  if (word.value.startsWith("-") || (spec.plus === true && word.value.startsWith("+"))) return true;
  return word.dynamic && (/^[$`]/.test(word.value) || word.cuts?.some((cut) => cut.at === 0) === true);
}

/** Reads one option word as getopt does; null when it is dynamic or holds a letter the spec does not know. */
function readOption(word: WordToken, next: WordToken | undefined, spec: WriterSpec): { slots: WordToken[]; width: number } | null {
  if (word.dynamic) return null;
  const body = word.value.slice(1);
  for (let k = 0; k < body.length; k++) {
    const letter = body.charAt(k);
    const takesName = has(spec.names, letter) || has(spec.either, letter);
    if (takesName || has(spec.values, letter)) {
      if (k + 1 < body.length) return { slots: takesName ? [sliceWord(word, k + 2)] : [], width: 1 };
      return { slots: takesName && next ? [next] : [], width: 2 };
    }
    if (has(spec.numeric, letter)) while (/\d/.test(body[k + 1] ?? "")) k++;
    else if (!has(spec.flags, letter) && !(spec.anyFlag === true && /[A-Za-z0-9]/.test(letter))) return null;
  }
  return { slots: [], width: 1 };
}

const has = (letters: string | undefined, letter: string) => letters?.includes(letter) === true;

function operandSlots(spec: WriterSpec, operands: WordToken[]): WordToken[] {
  if (spec.operands === "names") {
    const skip = spec.skip ?? 0;
    return [...operands.slice(0, skip).filter((w) => w.dynamic), ...operands.slice(skip)];
  }
  if (spec.operands === "none") return [];
  return operands.flatMap((w) => (w.value.includes("=") ? [sliceWord(w, w.value.indexOf("=") + 1)] : []));
}

/** The word from `from` on, so positions in its refs and cuts still index into its value. */
function sliceWord(word: WordToken, from: number): WordToken {
  return {
    ...word,
    value: word.value.slice(from),
    refs: word.refs.filter((r) => r.start >= from).map((r) => ({ ...r, start: r.start - from, end: r.end - from })),
    cuts: word.cuts?.filter((c) => c.at >= from).map((c) => ({ ...c, at: c.at - from })),
  };
}
