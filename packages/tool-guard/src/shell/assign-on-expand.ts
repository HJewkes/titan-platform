import { HOOKED, assignedInMath, writesComputedName } from "./hooked-names.js";
import { CUT_OFF, closeOf } from "./math-close.js";
import { joinedWindow, nextAfter } from "./joins.js";
import { PROTECTED } from "./protected-params.js";

const IDENTIFIER_AT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const ZSH_PREFIXES_AT_RE = /[=~^#+]*/y;
/** zsh parameter flags that take delimited arguments, with how many: `l` and `r` take up to three. */
const FLAG_ARG_COUNTS = new Map<string, number>([["j", 1], ["s", 1], ["I", 1], ["Z", 1], ["g", 1], ["_", 1], ["l", 3], ["r", 3]]);
const DELIMITER_PAIRS = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]]);
const MAX_FLAG_GROUP = 256;
/** Flags whose first argument zsh evaluates as math: the `l` and `r` widths and the `I` match index. */
const MATH_FLAGS = new Set(["l", "r", "I"]);
/** What opens a name that is computed, not spelled: a nested expansion, a substitution or a quote. */
const NESTED_NAME_RE = /[$`'"]/;
/** Brace expansion run on `{$,}{NAME:=x}` or `{$,}[NAME=0]` leaves `${NAME:=x}` or `$[NAME=0]` for bash to expand: a `$` ending an alternative, then a group holding an `=`. */
const BRACE_SPLICE_RE = /^[,}][^]*[{[][^]*=/;
const BRACE_SPLICE_START_RE = /^[,}]/;
/** The positional and special parameters an indirect expansion may name: `${!1}`, `${(P)@}`, `${!#}`. */
const SPECIAL_NAME_AT_RE = /[0-9]+|[-@*#?$!]/y;
const ASSIGN_OPERATOR_AT_RE = /:{0,2}=/y;
/** What an assign-on-expand through a name the shell resolves writes: only known at run time. */
const INDIRECT = Symbol("indirect");
/** How much of a `${` body is read for its target: past the longest flag group and name, so a longer subscript fails closed. */
const MAX_BODY = 600;

/**
 * The name a `${…}` in the text assigns while it expands: `${PS4:=x}`, `${PS4[0]=x}`, zsh `${(A)module_path::=x}`,
 * or the whole text for an indirect name, bash `${!N:=x}` or zsh `${(P)N::=x}`. Each scan stops at the next `$`,
 * where the next `${` is read, so the read is linear in the text.
 */
export function assignOnExpand(text: string, names: ReadonlySet<string> = HOOKED): string | null {
  for (let at = text.indexOf("${"); at >= 0; at = text.indexOf("${", at + 2)) {
    const target = assignedAt(text, at + 2, names);
    if (target !== null) return target === INDIRECT ? text : target;
  }
  return null;
}

/** The target of the expansion whose body starts at `at`, if it assigns; a scan cut short by a `$` fails closed. */
function assignedAt(text: string, at: number, names: ReadonlySet<string>): string | typeof INDIRECT | null {
  const head = expansionHead(text, at, names);
  if (head === "cut") return INDIRECT;
  if (head !== null && "evaluated" in head) return head.evaluated;
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
 * an indirect name cannot be read: a zsh flag group that does not close, or a nested `${…}` name.
 */
function expansionHead(
  text: string,
  at: number,
  names: ReadonlySet<string>,
): { target: string | typeof INDIRECT | null; end: number } | { evaluated: string } | "cut" | null {
  let i = skipZshPrefixes(text, at);
  let indirect = text[i] === "!";
  if (indirect) i++;
  else if (text[i] === "(") {
    const group = flagGroup(text, i + 1, names);
    if (group === null) return "cut";
    if (group.evaluated !== null) return { evaluated: group.evaluated };
    indirect = group.indirect;
    i = skipZshPrefixes(text, group.end);
  }
  if (indirect && NESTED_NAME_RE.test(text.charAt(i))) return "cut";
  IDENTIFIER_AT_RE.lastIndex = i;
  const name = IDENTIFIER_AT_RE.exec(text)?.[0];
  if (name === undefined) return indirect ? indirectSpecial(text, i) : null;
  const target = indirect ? INDIRECT : names.has(name) ? name : null;
  return { target, end: i + name.length };
}

/** What the guard finds at a `$`: a write to refuse, a body it could not read to its end, which is refused too, or neither. */
type ExpandVerdict = "writes" | "unread" | false;

const unreadIf = (cut: boolean): ExpandVerdict => (cut ? "unread" : false);

/**
 * Whether the `$` at `dollar` opens an expansion that assigns while it expands and whose target is not a plain
 * literal name the guard leaves alone: an indirect or nested name, or a protected one. The body is read as the shell
 * reads it, without the backslash-newlines it drops. A `$` that brace expansion may join to a later `{` or `[` counts
 * when that group assigns, since the line cannot say which name it spells. Every read that stops before a close it
 * pairs is "unread", whatever the window: the scan may have misread a nested unit the lexer reads.
 */
export function assignsProtectedAt(src: string, dollar: number): ExpandVerdict {
  const open = nextAfter(src, dollar);
  const { text: body, truncated } = joinedWindow(src, open, MAX_BODY);
  if (body.startsWith("{")) return assignedAt(body, 1, PROTECTED) !== null ? "writes" : braceMathWrites(body, truncated);
  if (body.startsWith("[")) return mathWrites(body, 1, "]");
  if (body.startsWith("((")) return mathWrites(body, 2, "))");
  if (!BRACE_SPLICE_START_RE.test(body)) return false;
  // a window that ends before a decision cannot show that no assigning group follows
  return BRACE_SPLICE_RE.test(body) ? "writes" : unreadIf(truncated);
}

/**
 * Whether the math in `text` from `from` up to its `close` writes a protected name, by its spelling or through a
 * name computed at run time. A `$((` whose `)` pairs before a `))` is the subshell `$((echo hi); echo there)`:
 * its commands are lexed, and `mathCloseDisagrees` refuses it if the lexer reads math there instead.
 */
function mathWrites(text: string, from: number, close: string): ExpandVerdict {
  const math = closeOf(text, from, close);
  if (math === CUT_OFF) return "unread";
  if (math.unpaired) return false;
  return mathHolds(text.slice(from, math.end), math.flat) ? "writes" : false;
}

/**
 * Whether the lexer, reading the `$((` or `$[` at `dollar` as math that ends at `last`, puts its close somewhere
 * other than the guard's scan did. The guard checked only the body it found, so any other reading is refused.
 */
export function mathCloseDisagrees(src: string, dollar: number, last: number): boolean {
  const open = nextAfter(src, dollar);
  const { text: body } = joinedWindow(src, open, MAX_BODY);
  const close = body.startsWith("((") ? "))" : "]";
  const math = closeOf(body, close.length, close);
  if (math === CUT_OFF || math.unpaired) return true;
  return joinedWindow(src.slice(0, last), open, MAX_BODY).text.length !== math.end + close.length - 1;
}

function mathHolds(text: string, flat: string): boolean {
  return assignedInMath(text, PROTECTED) !== null || writesComputedName(flat);
}

/**
 * The math a `${…}` evaluates while it expands: the subscript `${a[…]}` and the bash substring offset and length
 * `${x:…}`. A `:` followed by `-=+?#` is a default, an assignment or a removal and holds text, not math.
 */
function braceMathWrites(body: string, truncated: boolean): ExpandVerdict {
  let i = bracedNameEnd(body);
  // a head read that stops at the window edge never saw what follows the name, so a cut window fails closed
  if (i < 0) return unreadIf(truncated && skipZshPrefixes(body, 1) >= body.length);
  if (i >= body.length) return unreadIf(truncated);
  if (body[i] === "[") {
    const math = closeOf(body, i + 1, "]");
    if (math === CUT_OFF) return "unread";
    if (mathHolds(body.slice(i + 1, math.end), math.flat)) return "writes";
    i = math.end + 1;
  }
  if (i >= body.length) return unreadIf(truncated);
  if (body[i] !== ":" || /^:(?:[-=+?#]|:=)/.test(body.slice(i))) return false;
  return mathWrites(body, i + 1, "}");
}

/** Where the name of the `${` expansion ends, after any flags and prefixes; -1 when the text holds none the guard can read. */
function bracedNameEnd(body: string): number {
  const head = expansionHead(body, 1, PROTECTED);
  if (head !== null && head !== "cut" && "end" in head) return head.end;
  const at = skipZshPrefixes(body, 1);
  SPECIAL_NAME_AT_RE.lastIndex = at;
  const special = SPECIAL_NAME_AT_RE.exec(body)?.[0];
  return special === undefined ? -1 : at + special.length;
}

/** An indirect name that is no identifier, `${!1}` or zsh `${(P)@}`, still names a parameter at run time; any other text there is unreadable. */
function indirectSpecial(text: string, at: number): { target: typeof INDIRECT; end: number } | "cut" {
  SPECIAL_NAME_AT_RE.lastIndex = at;
  const special = SPECIAL_NAME_AT_RE.exec(text)?.[0];
  return special === undefined ? "cut" : { target: INDIRECT, end: at + special.length };
}

/** The first name in `names` the text mentions as a whole identifier. */
function mentionedIn(text: string, names: ReadonlySet<string>): string | null {
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (names.has(word)) return word;
  return null;
}

/** zsh `${=…}`, `${~…}`, `${^…}`, `${#…}`, `${+…}` and their doubled forms, before or after a flag group; each still assigns. */
function skipZshPrefixes(text: string, at: number): number {
  ZSH_PREFIXES_AT_RE.lastIndex = at;
  return at + (ZSH_PREFIXES_AT_RE.exec(text)?.[0].length ?? 0);
}

/**
 * A zsh flag group after its `(`: whether it holds the P flag, the first hooked name the math argument of an
 * `l`, `r` or `I` flag mentions, and the index after its `)`. Flags such as `s:…:`
 * take arguments in their own delimiters, which may hold `)`, `P` or `$`. Null when it does not close within
 * `MAX_FLAG_GROUP` characters, which also bounds the work per `${`.
 */
function flagGroup(text: string, from: number, names: ReadonlySet<string>): { indirect: boolean; evaluated: string | null; end: number } | null {
  const limit = Math.min(text.length, from + MAX_FLAG_GROUP);
  let indirect = false;
  let evaluated: string | null = null;
  for (let i = from; i < limit; i++) {
    const flag = text.charAt(i);
    if (flag === ")") return { indirect, evaluated, end: i + 1 };
    if (flag === "P") indirect = true;
    else if (FLAG_ARG_COUNTS.has(flag)) {
      const end = flagArgs(text, i + 1, FLAG_ARG_COUNTS.get(flag) ?? 1, limit);
      if (end < 0) return null;
      if (MATH_FLAGS.has(flag)) evaluated ??= mentionedIn(text.slice(i + 2, flagArgs(text, i + 1, 1, limit) - 1), names);
      i = end - 1;
    }
  }
  return null;
}

/** The index after a flag's arguments, the first required and the rest optional; -1 when one runs past `limit`. */
function flagArgs(text: string, at: number, count: number, limit: number): number {
  const open = text.charAt(at);
  if (open === "" || open === ")") return -1;
  const close = DELIMITER_PAIRS.get(open) ?? open;
  let i = at;
  for (let n = 0; n < count && text[i] === open; n++) {
    const end = text.slice(i + 1, limit).indexOf(close);
    if (end < 0) return -1;
    i += end + 2;
  }
  return i;
}

/** The index of `close`, or of the first `$` or the end of the text, whichever comes first. */
function scanTo(text: string, from: number, close: string): number {
  let i = from;
  while (i < text.length && text[i] !== close && text[i] !== "$") i++;
  return i;
}
