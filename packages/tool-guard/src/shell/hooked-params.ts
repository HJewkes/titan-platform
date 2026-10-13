import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { TARGET_RE } from "./writers.js";

/** Parameters whose value a shell later runs as code: the bash/zsh trace prompt and zsh's module search path. */
const HOOKED = new Set(["PS4", "PROMPT4", "module_path", "MODULE_PATH"]);

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
  /** zsh/stat's builtin shares its name with GNU and BSD stat: `-t` and BSD `-f` take a format, GNU `-f` and BSD `-F` are flags. */
  stat: { ...ZSTAT, values: "c", either: "fFt", flags: "gnNolLTrsqx", longOptions: true },
  zselect: { names: "aA", values: "t", flags: "rwe", operands: "none" },
  getln: { flags: "AclneE", operands: "names" },
  sysread: { names: "c", values: "iost", operands: "names" },
  zregexparse: { flags: "c", operands: "names" },
  pcre_match: { names: "va", values: "n", flags: "b", operands: "none" },
};

const NAMEREF_DECLARERS = new Set(["declare", "typeset", "local", "private"]);

const IDENTIFIER_AT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const ASSIGN_OPERATOR_AT_RE = /:{0,2}=/y;
/** What an assign-on-expand through a name the shell resolves writes: only known at run time. */
const INDIRECT = Symbol("indirect");

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
    const value = tail ? { ...word, value: tail } : has(spec.values, letter) ? null : (args[i + 1] ?? null);
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
  if (word.dynamic || word.value.length > MAX_OPTION_WORD) return word.value;
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
  return word.dynamic && (/^[$`]/.test(word.value) || word.cuts?.some((cut) => cut.at === 0) === true);
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

/** Only a dynamic word expands: a quoted `'${PS4:=x}'` in a commit message is text. An indirect name returns the word. */
function expansionHooked(words: WordToken[]): string | null {
  for (const word of words.filter((w) => w.dynamic)) {
    const hooked = assignOnExpand(word.value);
    if (hooked !== null) return hooked;
  }
  return null;
}

/**
 * The name a `${…}` in the text assigns while it expands: `${PS4:=x}`, `${PS4[0]=x}`, zsh `${(A)module_path::=x}`,
 * or the whole text for an indirect name, bash `${!N:=x}` or zsh `${(P)N::=x}`. Each scan stops at the next `$`,
 * where the next `${` is read, so the read is linear in the text.
 */
function assignOnExpand(text: string): string | null {
  for (let at = text.indexOf("${"); at >= 0; at = text.indexOf("${", at + 2)) {
    const target = assignedAt(text, at + 2);
    if (target !== null) return target === INDIRECT ? text : target;
  }
  return null;
}

/** The target of the expansion whose body starts at `at`, if it assigns; a scan cut short by a `$` fails closed. */
function assignedAt(text: string, at: number): string | typeof INDIRECT | null {
  const head = expansionHead(text, at);
  if (head === "cut") return INDIRECT;
  if (head === null || head.target === null) return null;
  let i = head.end;
  if (text[i] === "[") {
    const close = scanTo(text, i + 1, "]");
    if (text[close] !== "]") return head.target;
    i = close + 1;
  }
  ASSIGN_OPERATOR_AT_RE.lastIndex = i;
  return ASSIGN_OPERATOR_AT_RE.test(text) ? head.target : null;
}

/**
 * The `!` or zsh flags and the name after `${`: the hooked or indirect target, and where the name ends. "cut" when
 * an indirect name cannot be read: zsh flags a `$` cuts short, or a nested `${…}` name.
 */
function expansionHead(text: string, at: number): { target: string | typeof INDIRECT | null; end: number } | "cut" | null {
  let i = at;
  let indirect = text[i] === "!";
  if (indirect) i++;
  else if (text[i] === "(") {
    const close = scanTo(text, i + 1, ")");
    indirect = text.slice(i + 1, close).includes("P");
    if (text[close] !== ")") return indirect ? "cut" : null;
    i = close + 1;
  }
  if (indirect && text.startsWith("${", i)) return "cut";
  IDENTIFIER_AT_RE.lastIndex = i;
  const name = IDENTIFIER_AT_RE.exec(text)?.[0];
  if (name === undefined) return null;
  const target = indirect ? INDIRECT : HOOKED.has(name) ? name : null;
  return { target, end: i + name.length };
}

/** The index of `close`, or of the first `$` or the end of the text, whichever comes first. */
function scanTo(text: string, from: number, close: string): number {
  let i = from;
  while (i < text.length && text[i] !== close && text[i] !== "$") i++;
  return i;
}
