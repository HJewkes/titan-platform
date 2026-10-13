import type { WordToken } from "./tokens.js";

/**
 * How a name-writing builtin reads its words, as the union of bash and zsh. Each string lists option letters; a
 * letter in none of them is unknown, and the command then fails closed.
 */
interface WriterSpec {
  /** Options whose value, attached or next, is a name the command writes. */
  names?: string;
  /** Options whose value, attached or next, is not a name. */
  values?: string;
  /** Options that take a value in one shell and are a flag in the other, so the next word may be a name. */
  either?: string;
  /** zsh options with an optional attached number, such as `typeset -L10`. */
  numeric?: string;
  flags?: string;
  /** Whether every other letter or digit is a flag, as for `set`. */
  anyFlag?: boolean;
  /** Whether a `+` cluster is an option word too. */
  plus?: boolean;
  /** Whether a `--name` word is an option of another command of the same name, which writes no name. */
  longOptions?: boolean;
  /** Which operands are names: all of them, none, or each zparseopts spec's array after `=`. */
  operands: "names" | "none" | "specs";
}

const DECLARE: WriterSpec = { flags: "aAfFgGhHiIklLmnprRtTuUxzEZ", numeric: "EFLRZip", plus: true, operands: "names" };

const ZSTAT: WriterSpec = { names: "AH", values: "fF", flags: "gnNolLtTrs", operands: "none" };

const SPECS: Record<string, WriterSpec> = {
  export: DECLARE, declare: DECLARE, typeset: DECLARE, local: DECLARE, readonly: DECLARE, private: DECLARE,
  unset: { flags: "fvn", operands: "names" },
  read: { names: "a", values: "diNu", either: "npt", numeric: "k", flags: "ersqzcAlE", operands: "names" },
  mapfile: { values: "dnOsuCc", flags: "t", operands: "names" },
  readarray: { values: "dnOsuCc", flags: "t", operands: "names" },
  printf: { names: "v", operands: "none" },
  print: { names: "v", values: "CfuxX", flags: "abcDilmnNoOpPrRsSz", operands: "none" },
  set: { names: "A", values: "o", anyFlag: true, plus: true, operands: "none" },
  wait: { names: "p", flags: "nf", operands: "none" },
  compgen: { names: "V", values: "AGWFCXPSo", flags: "abcdefgjksuv", operands: "none" },
  vared: { values: "prMmift", flags: "Aacghe", operands: "names" },
  zstyle: { flags: "sabtTmgedL", operands: "names" },
  zparseopts: { names: "aAv", flags: "DEFKM", operands: "specs" },
  zformat: { names: "faF", operands: "none" },
  strftime: { names: "s", flags: "rqn", operands: "none" },
  zstat: ZSTAT,
  /** zsh/stat's builtin shares its name with GNU and BSD stat, whose `-c` and `-t` take a format. */
  stat: { ...ZSTAT, values: "fFct", flags: "gnNolLTrsqx", longOptions: true },
  zselect: { names: "aA", values: "t", flags: "rwe", operands: "none" },
  getln: { flags: "AclneE", operands: "names" },
  sysread: { names: "c", values: "iost", operands: "names" },
  zregexparse: { flags: "c", operands: "names" },
  pcre_match: { names: "va", values: "n", flags: "b", operands: "none" },
};

/** Declarers whose `-n` makes each operand a nameref, so its target names the variable later writes reach. */
export const NAMEREF_DECLARERS = new Set(["declare", "typeset", "local", "private"]);

/**
 * The words a command reads as names it writes, or the text of an option word the table cannot read, which the
 * caller fails closed on. A command the table does not know writes no name. Attached option values and
 * zparseopts arrays come back as words sliced to the name, with their refs and cuts moved along.
 */
export function nameSlots(name: string, args: WordToken[]): WordToken[] | string {
  if (name === "for" || name === "select") return forNames(args);
  if (name === "getopts") return args.slice(1, 2);
  const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
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
  if (spec.operands === "names") return operands;
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
