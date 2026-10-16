import type { RedirectToken, WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { arithmeticHookedIn } from "./arith-hooked.js";
import { assignOnExpand } from "./assign-on-expand.js";
import { HOOKED } from "./hooked-names.js";
import { TARGET_RE } from "./writers.js";


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
  /** Leading operands that are not names, such as the file operand of `zlistattr`. */
  skip?: number;
}

const DECLARE: WriterSpec = { flags: "aAfFgGhHiIklLmnprRtTuUxzEZ", numeric: "EFLRZip", plus: true, operands: "names" };

const ZSTAT: WriterSpec = { names: "AH", values: "fF", flags: "gnNolLtTrs", operands: "none" };

/** zsh/computil's builtins name the arrays they fill in operands whose positions depend on the mode, so each operand counts. */
const COMPLETION_INTERNAL: WriterSpec = { anyFlag: true, operands: "names" };

const SPECS: Record<string, WriterSpec> = {
  export: DECLARE, declare: DECLARE, typeset: DECLARE, local: DECLARE, readonly: DECLARE, private: DECLARE,
  integer: DECLARE, float: DECLARE,
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
  /** zsh/stat's builtin shares its name with GNU and BSD stat: `-t` and BSD `-f` take a format, GNU `-f` and BSD `-F` are flags. */
  stat: { ...ZSTAT, values: "c", either: "fFt", flags: "gnNolLTrsqx", longOptions: true },
  zselect: { names: "aA", values: "t", flags: "rwe", operands: "none" },
  getln: { flags: "AclneE", operands: "names" },
  sysread: { names: "c", values: "iost", operands: "names" },
  zregexparse: { flags: "c", operands: "names" },
  pcre_match: { names: "va", values: "n", flags: "b", operands: "none" },
  zpty: { flags: "ebdtLrwnm", skip: 1, operands: "names" },
  zsystem: { operands: "names" },
  syserror: { names: "e", values: "p", operands: "none" },
  sysopen: { names: "u", values: "mo", flags: "arw", operands: "none" },
  syswrite: { names: "c", values: "o", operands: "none" },
  zmodload: { names: "P", flags: "dLsiFabcpfIeARulm", operands: "none" },
  zgetattr: { flags: "h", skip: 2, operands: "names" },
  zlistattr: { flags: "h", skip: 1, operands: "names" },
  ztie: { values: "df", flags: "rzZS", operands: "names" },
  zcurses: { operands: "names" },
  shift: { flags: "p", operands: "names" },
  compadd: { names: "OAD", values: "PSpsiIWdJVXxrRMEF", either: "o", flags: "UQqaklfn12C", operands: "none" },
  comparguments: COMPLETION_INTERNAL, compvalues: COMPLETION_INTERNAL, compdescribe: COMPLETION_INTERNAL,
  comptags: COMPLETION_INTERNAL, compfiles: COMPLETION_INTERNAL,
  compquote: { flags: "p", operands: "names" },
};

const NAMEREF_DECLARERS = new Set(["declare", "typeset", "local", "private"]);


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
 * `redirects` are its redirections: a herestring or heredoc body may hold text a later `(( x ))` reads as math.
 */
export function writesHookedParam(cmd: Unwrapped, words: WordToken[], redirects: RedirectToken[] = []): string | null {
  return writesProtectedParam(cmd, words, redirects, HOOKED);
}

/**
 * The same store reader over any set of names, such as zsh's `options`. Only the stores read the set: the
 * assign-on-expand scan and the arithmetic half stay on `HOOKED`, because a math write to `options` is an error
 * in zsh and `assignOnExpand` takes no set yet.
 */
export function writesProtectedParam(
  cmd: Unwrapped,
  words: WordToken[],
  redirects: RedirectToken[],
  names: ReadonlySet<string>,
): string | null {
  const slots = nameSlots(cmd);
  return (
    assignedHooked(cmd, names) ??
    slotsHooked(slots, names) ??
    namerefHooked(cmd, names) ??
    expansionHooked([...words, ...cmd.args]) ??
    fdVariableHooked([...words, ...cmd.args], redirects, names) ??
    arithmeticHookedIn(cmd, words, typeof slots === "string" ? [] : slots, redirects)
  );
}

function assignedHooked(cmd: Unwrapped, names: ReadonlySet<string>): string | null {
  return cmd.assigned.find(([name]) => names.has(name))?.[0] ?? null;
}

function slotsHooked(slots: WordToken[] | string, names: ReadonlySet<string>): string | null {
  if (typeof slots === "string") return slots;
  for (const slot of slots) {
    const hooked = slotHooked(slot, names);
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

/**
 * What a walk collects: option values that are slots, and the earliest word where some reading's operands start.
 * Every reading's operands are a suffix of the arguments, so the earliest start covers them all, slotted once.
 */
interface OptionWalk {
  slots: WordToken[];
  operandsFrom: number;
}

/**
 * Walks the option words as every shell may read them. A state is a word index and a letter offset in it (0 before
 * the word); an either-letter queues both readings, and each state is read once, so the walk stays linear.
 */
function specSlots(spec: WriterSpec, args: WordToken[]): WordToken[] | string {
  const walk: OptionWalk = { slots: [], operandsFrom: args.length };
  const seen = new Set<string>();
  const pending: Array<[number, number]> = [[0, 0]];
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    const key = state.join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const next = step(spec, args, state, walk);
    if (typeof next === "string") return next;
    pending.push(...next);
  }
  return [...walk.slots, ...operandSlots(spec, args.slice(walk.operandsFrom))];
}

/**
 * One step of the walk: the states it leads to, or the text of an option word that fails closed. Any attached tail
 * is a slot, and so is the next word after a name or either-letter. A character no shell takes as an option ends
 * the reading, since the shell then refuses the command.
 */
function step(spec: WriterSpec, args: WordToken[], [i, k]: [number, number], walk: OptionWalk): Array<[number, number]> | string {
  const word = args[i];
  if (word === undefined) return [];
  if (k === 0) return startWord(spec, i, word, walk);
  if (k >= word.value.length) return [[i + 1, 0]];
  const letter = word.value.charAt(k);
  const tail = word.value.slice(k + 1);
  const either = has(spec.either, letter);
  if (either || has(spec.names, letter) || has(spec.values, letter)) {
    const value = tail ? { ...word, value: tail } : optionValue(spec, letter, args[i + 1]);
    if (value !== null) walk.slots.push(value);
    const after: [number, number] = tail ? [i + 1, 0] : [i + 2, 0];
    return either ? [after, [i, k + 1]] : [after];
  }
  if (has(spec.numeric, letter)) return [[i, k + 1 + (/^\d*/.exec(tail)?.[0].length ?? 0)]];
  if (has(spec.flags, letter) || (spec.anyFlag === true && /[A-Za-z0-9]/.test(letter))) return [[i, k + 1]];
  return /[A-Za-z0-9]/.test(letter) ? word.value : [];
}

/** Past this length an option word is not walked letter by letter, and it counts as a hooked write. */
const MAX_OPTION_WORD = 256;

/** At a word's start: the operands once options end, or the first letter of an option word. */
function startWord(spec: WriterSpec, i: number, word: WordToken, walk: OptionWalk): Array<[number, number]> | string {
  if (!mayBeOption(word, spec)) {
    walk.operandsFrom = Math.min(walk.operandsFrom, i);
    return [];
  }
  if (word.dynamic || word.value.length > MAX_OPTION_WORD || bracesExpand(word)) return word.value;
  if (word.value === "--" || word.value === "-") {
    walk.operandsFrom = Math.min(walk.operandsFrom, i + 1);
    return [];
  }
  if (spec.longOptions === true && word.value.startsWith("--")) return [[i + 1, 0]];
  return [[i, 1]];
}

/** A dynamic word that opens with an expansion may expand to an option. */
function mayBeOption(word: WordToken, spec: WriterSpec): boolean {
  if (word.value.startsWith("-") || (spec.plus === true && word.value.startsWith("+"))) return true;
  if (bracesExpand(word)) return true;
  return word.dynamic && (/^[$`]/.test(word.value) || word.cuts?.some((cut) => cut.at === 0) === true);
}

/** An unquoted brace may expand into several words, any of them an option: `print {-v,PS4}`. */
const bracesExpand = (word: WordToken) => !word.quoted && !word.dynamic && word.value.includes("{");

/**
 * A single word the shell reads as written: no expansion, glob or brace can turn it into other words. A word that
 * fails this may hold a name in a position the readers skip, so each skip keeps it as a slot.
 */
function literalWord(word: WordToken): boolean {
  return !word.dynamic && !word.spliced && (word.quoted || !EXPANDING_RE.test(word.value));
}

/** The word after a value-taking letter: a name slot, or the value, which counts only if it may expand into words. */
function optionValue(spec: WriterSpec, letter: string, next: WordToken | undefined): WordToken | null {
  if (next === undefined) return null;
  return has(spec.values, letter) && literalWord(next) ? null : next;
}

const has = (letters: string | undefined, letter: string) => letters?.includes(letter) === true;

function operandSlots(spec: WriterSpec, operands: WordToken[]): WordToken[] {
  if (spec.operands === "names") {
    const skip = spec.skip ?? 0;
    return [...operands.slice(0, skip).filter((w) => !literalWord(w)), ...operands.slice(skip)];
  }
  if (spec.operands === "none") return [];
  return operands.flatMap((w) => {
    if (!literalWord(w)) return [w];
    return w.value.includes("=") ? [{ ...w, value: w.value.slice(w.value.indexOf("=") + 1) }] : [];
  });
}

/**
 * A slot passes when it is literal and names no hooked parameter: an identifier with an optional literal
 * subscript, or any other literal text, which the shell rejects as a name without writing.
 */
function slotHooked(slot: WordToken, names: ReadonlySet<string>): string | null {
  const name = namePart(slot);
  if (name === null) return slot.value;
  const quoted = slot.quoted && !slot.spliced;
  if (!quoted && !PLAIN_NAME_RE.test(name) && EXPANDING_RE.test(name)) return slot.value;
  const identifier = IDENTIFIER_PREFIX_RE.exec(name)?.[0];
  if (identifier !== undefined && names.has(identifier)) return identifier;
  return !quoted && subscriptGlobsHooked(name, names) ? slot.value : null;
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
function subscriptGlobsHooked(name: string, names: ReadonlySet<string>): boolean {
  const [, base, chars] = SUBSCRIPTED_RE.exec(name) ?? [];
  return base !== undefined && [...(chars ?? "")].some((ch) => names.has(base + ch));
}

/**
 * A nameref's target: `declare -n R=PS4[0]` makes every later `R=` a PS4 write. Under `-n` a target must be a
 * literal name, and a bare `declare -n r` counts too, since a later `r=PS4` binds it.
 */
function namerefHooked({ name, args }: Unwrapped, names: ReadonlySet<string>): string | null {
  if (name === null || !Object.hasOwn(SPECS, name) || SPECS[name] !== DECLARE) return null;
  const nameref = NAMEREF_DECLARERS.has(name) && args.some((a) => !a.dynamic && /^-[A-Za-z0-9]*n/.test(a.value));
  for (const word of args.filter((a) => !/^[-+]/.test(a.value))) {
    const target = word.value.includes("=") ? word.value.slice(word.value.indexOf("=") + 1) : null;
    const named = target === null ? undefined : TARGET_RE.exec(target)?.[1];
    if (named !== undefined && names.has(named)) return named;
    if (nameref && (named === undefined || (word.dynamic && /[$`]/.test(target ?? "")) || word.cuts?.length)) return word.value;
  }
  return null;
}

const FD_VARIABLE_RE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * `exec {PS4}>f` stores a descriptor number into PS4. The lexer keeps `{PS4}` as a word with no sign of the
 * redirection it belongs to, so any redirection on the command makes an unquoted literal `{name}` word a possible
 * store. A quoted, escaped or computed `{...}` is text to the shell and stores nothing.
 */
function fdVariableHooked(words: WordToken[], redirects: RedirectToken[], names: ReadonlySet<string>): string | null {
  if (redirects.length === 0) return null;
  for (const word of words) {
    if (word.quoted || word.dynamic || word.spliced) continue;
    const named = FD_VARIABLE_RE.exec(word.value)?.[1];
    if (named !== undefined && names.has(named)) return named;
  }
  return null;
}

/** Only a dynamic word expands: a quoted `'${PS4:=x}'` in a commit message is text. An indirect name returns the word. */
function expansionHooked(words: WordToken[]): string | null {
  for (const word of words.filter((w) => w.dynamic)) {
    const hooked = assignOnExpand(word.value);
    if (hooked !== null) return hooked;
  }
  return null;
}
