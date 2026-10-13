import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { TARGET_RE } from "./writers.js";

/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
const HOOKED = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);
const HOOKED_ALT = [...HOOKED].join("|");

/**
 * How a name-writing builtin reads its words, as the union of bash and zsh. Each string lists option letters; a
 * letter in none of them is unknown, and the command then counts as a hooked write.
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

const NAMEREF_DECLARERS = new Set(["declare", "typeset", "local", "private"]);

/** `${PS4:=x}`, `${PS4[0]=x}` and zsh `${(A)module_path::=x}` assign while they expand. */
const DEFAULT_ASSIGN_RE = new RegExp(`\\$\\{(?:\\([^)]*\\))?(${HOOKED_ALT})(?:\\[.*\\])?:{0,2}=`, "s");

const IDENTIFIER_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
/** The only unquoted name a slot may hold: an identifier with an optional literal subscript. */
const PLAIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z0-9_]*\])?$/;
/** Characters that expand, glob or brace-expand outside quotes, in bash or zsh. */
const EXPANDING_RE = /[$`*?[\]{}~^#]/;
const SUBSCRIPTED_RE = /^([A-Za-z_][A-Za-z0-9_]*)\[([A-Za-z0-9_]*)\]$/;

/**
 * The first hooked parameter the command writes, or null. Any value counts: bash decodes `\044` to `$` before it
 * expands PS4, so no check of the value can be sound. `words` are the command's own words as written, prefix
 * assignments included: `Unwrapped.assigned` keeps no text for a dynamic value such as `X=${PS4:=x}`. A name
 * slot the shell computes (expanded, globbed, braced) or an option word the spec cannot read returns its text.
 */
export function writesHookedParam(cmd: Unwrapped, words: WordToken[]): string | null {
  return (
    assignedHooked(cmd) ??
    slotsHooked(cmd) ??
    namerefHooked(cmd) ??
    expansionHooked([...words, ...cmd.args])
  );
}

function assignedHooked(cmd: Unwrapped): string | null {
  return cmd.assigned.find(([name]) => HOOKED.has(name))?.[0] ?? null;
}

function slotsHooked(cmd: Unwrapped): string | null {
  const slots = nameSlots(cmd);
  if (typeof slots === "string") return slots;
  for (const slot of slots) {
    const hooked = slotHooked(slot);
    if (hooked !== null) return hooked;
  }
  return null;
}

/** The words a command reads as names it writes, or the text of an option word that fails closed. */
function nameSlots({ name, args }: Unwrapped): WordToken[] | string {
  if (name === null) return [];
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
    const tail = body.slice(k + 1);
    const takesName = has(spec.names, letter) || has(spec.either, letter);
    if (takesName || has(spec.values, letter)) {
      if (tail) return { slots: [{ ...word, value: tail }], width: 1 };
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
  return operands.flatMap((w) => (w.value.includes("=") ? [{ ...w, value: w.value.slice(w.value.indexOf("=") + 1) }] : []));
}

/**
 * A slot passes when it is literal and names no hooked parameter: an identifier with an optional literal
 * subscript, or any other literal text, which the shell rejects as a name without writing.
 */
function slotHooked(slot: WordToken): string | null {
  const name = namePart(slot);
  if (name === null) return slot.value;
  const quoted = slot.quoted && !slot.spliced;
  if (!quoted && !PLAIN_NAME_RE.test(name) && EXPANDING_RE.test(name)) return slot.value;
  const identifier = IDENTIFIER_PREFIX_RE.exec(name)?.[0];
  if (identifier !== undefined && HOOKED.has(identifier)) return identifier;
  return !quoted && subscriptGlobsHooked(name) ? slot.value : null;
}

/** The text before the first `=` (and a `+=`'s `+`), or null when an expansion sits there. */
function namePart(slot: WordToken): string | null {
  const eq = slot.value.indexOf("=");
  const end = eq < 0 ? slot.value.length : eq;
  const name = slot.value.slice(0, end);
  if (slot.dynamic && (/[$`]/.test(name) || slot.cuts?.some((cut) => cut.at <= end))) return null;
  return name.replace(/\+$/, "");
}

/** An unquoted `PS[4]` is a bracket expression too, and globs to PS4 once a file of that name exists. */
function subscriptGlobsHooked(name: string): boolean {
  const [, base, chars] = SUBSCRIPTED_RE.exec(name) ?? [];
  return base !== undefined && [...(chars ?? "")].some((ch) => HOOKED.has(base + ch));
}

/**
 * A nameref's target: `declare -n R=PS4[0]` makes every later `R=` a PS4 write. Under `-n` a target must be a
 * literal name, and a bare `declare -n r` counts too, since a later `r=PS4` binds it.
 */
function namerefHooked({ name, args }: Unwrapped): string | null {
  if (name === null || !Object.hasOwn(SPECS, name) || SPECS[name] !== DECLARE) return null;
  const nameref = NAMEREF_DECLARERS.has(name) && args.some((a) => !a.dynamic && /^-[A-Za-z0-9]*n/.test(a.value));
  for (const word of args.filter((a) => !/^[-+]/.test(a.value))) {
    const target = word.value.includes("=") ? word.value.slice(word.value.indexOf("=") + 1) : null;
    const named = target === null ? undefined : TARGET_RE.exec(target)?.[1];
    if (named !== undefined && HOOKED.has(named)) return named;
    if (nameref && (named === undefined || (word.dynamic && /[$`]/.test(target ?? "")) || word.cuts?.length)) return word.value;
  }
  return null;
}

/** Only a dynamic word expands: a quoted `'${PS4:=x}'` in a commit message is text. */
function expansionHooked(words: WordToken[]): string | null {
  for (const word of words) {
    const name = word.dynamic ? DEFAULT_ASSIGN_RE.exec(word.value)?.[1] : undefined;
    if (name !== undefined) return name;
  }
  return null;
}
