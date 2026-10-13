import { HOOKED } from "./hooked-names.js";

const IDENTIFIER_AT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const ZSH_PREFIXES_AT_RE = /[=~^#+]*/y;
/** zsh parameter flags that take delimited arguments, with how many: `l` and `r` take up to three. */
const FLAG_ARG_COUNTS = new Map<string, number>([["j", 1], ["s", 1], ["I", 1], ["Z", 1], ["g", 1], ["_", 1], ["l", 3], ["r", 3]]);
const DELIMITER_PAIRS = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]]);
const MAX_FLAG_GROUP = 256;
const ASSIGN_OPERATOR_AT_RE = /:{0,2}=/y;
/** What an assign-on-expand through a name the shell resolves writes: only known at run time. */
const INDIRECT = Symbol("indirect");

/**
 * The name a `${…}` in the text assigns while it expands: `${PS4:=x}`, `${PS4[0]=x}`, zsh `${(A)module_path::=x}`,
 * or the whole text for an indirect name, bash `${!N:=x}` or zsh `${(P)N::=x}`. Each scan stops at the next `$`,
 * where the next `${` is read, so the read is linear in the text.
 */
export function assignOnExpand(text: string): string | null {
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
 * an indirect name cannot be read: a zsh flag group that does not close, or a nested `${…}` name.
 */
function expansionHead(text: string, at: number): { target: string | typeof INDIRECT | null; end: number } | "cut" | null {
  let i = skipZshPrefixes(text, at);
  let indirect = text[i] === "!";
  if (indirect) i++;
  else if (text[i] === "(") {
    const group = flagGroup(text, i + 1);
    if (group === null) return "cut";
    indirect = group.indirect;
    i = skipZshPrefixes(text, group.end);
  }
  if (indirect && text.startsWith("${", i)) return "cut";
  IDENTIFIER_AT_RE.lastIndex = i;
  const name = IDENTIFIER_AT_RE.exec(text)?.[0];
  if (name === undefined) return null;
  const target = indirect ? INDIRECT : HOOKED.has(name) ? name : null;
  return { target, end: i + name.length };
}

/** zsh `${=…}`, `${~…}`, `${^…}`, `${#…}`, `${+…}` and their doubled forms, before or after a flag group; each still assigns. */
function skipZshPrefixes(text: string, at: number): number {
  ZSH_PREFIXES_AT_RE.lastIndex = at;
  return at + (ZSH_PREFIXES_AT_RE.exec(text)?.[0].length ?? 0);
}

/**
 * A zsh flag group after its `(`: whether it holds the P flag, and the index after its `)`. Flags such as `s:…:`
 * take arguments in their own delimiters, which may hold `)`, `P` or `$`. Null when it does not close within
 * `MAX_FLAG_GROUP` characters, which also bounds the work per `${`.
 */
function flagGroup(text: string, from: number): { indirect: boolean; end: number } | null {
  const limit = Math.min(text.length, from + MAX_FLAG_GROUP);
  let indirect = false;
  for (let i = from; i < limit; i++) {
    const flag = text.charAt(i);
    if (flag === ")") return { indirect, end: i + 1 };
    if (flag === "P") indirect = true;
    else if (FLAG_ARG_COUNTS.has(flag)) {
      const end = flagArgs(text, i + 1, FLAG_ARG_COUNTS.get(flag) ?? 1, limit);
      if (end < 0) return null;
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
