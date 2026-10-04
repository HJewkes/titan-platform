import type { OpToken, Token, VarRef, WordToken } from "./lexer.js";
import { ASSIGNMENT_RE } from "./vars.js";

const LOCAL_MAKERS = new Set(["local", "declare", "typeset"]);
const COMMAND_STARTS = new Set(["{", "then", "do", "else", "elif", "if", "while", "until", "!"]);
const BARE_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=$/;
const APPEND_RE = /^[A-Za-z_][A-Za-z0-9_]*\+=/;
const DECLARED_NAME = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+?=|$)/;
const PATTERN_OPS = new Set(["(", ")", "|"]);
const SEPARATOR: OpToken = { type: "op", value: ";" };

type Group = "{" | "(";

interface Body {
  group: Group;
  /** The depth of its group outside it. */
  depth: number;
  /** The `( )` depth inside it: a local in a deeper subshell ends with that subshell, which the walk already scopes. */
  parens: number;
  /** Each local the body made, with the hidden variable holding the value it had outside. */
  saved: Array<[name: string, slot: string]>;
}

interface Pass {
  out: Token[];
  /** The next word starts a command. */
  start: boolean;
  /** `function` was read and its name is next, or `NAME ()` or `function NAME` was read and its body is next. */
  header: "name" | "body" | null;
  depths: Record<Group, number>;
  bodies: Body[];
  /** The command makes a new local, so an append in it starts from empty. */
  local: boolean;
  /** Open `case` commands; `awaitIn` waits for the `in` before the first pattern, `pattern` is set while one is read. */
  cases: number;
  awaitIn: boolean;
  pattern: boolean;
  slots: number;
}

/**
 * Rewrites what variable tracking cannot read word by word. `NAME=(a b)` becomes `NAME=a`, the element 0
 * that `$NAME` reads. An append that makes a new function local loses its `+`, and a `{ }` function body
 * saves each local's outer value before it and restores it at the closing brace, as bash does on return.
 */
export function normalizeDeclarations(tokens: Token[]): Token[] {
  const p: Pass = {
    out: [], start: true, header: null, depths: { "{": 0, "(": 0 }, bodies: [], local: false,
    cases: 0, awaitIn: false, pattern: false, slots: 0,
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as Token;
    if (token.type === "op") i = op(tokens, i, p);
    else if (token.type === "word") i = word(tokens, i, p);
    else p.out.push(tokens[i++] as Token);
  }
  return p.out;
}

/** A case pattern's `(`, `|` and `)` become separators, so they neither pipe nor open or close a group. */
function op(tokens: Token[], i: number, p: Pass): number {
  const token = tokens[i] as OpToken;
  const next = tokens[i + 1];
  if (p.pattern && PATTERN_OPS.has(token.value)) {
    p.out.push(SEPARATOR);
    p.pattern = token.value !== ")";
  } else if (token.value === "(" && next?.type === "op" && next.value === ")" && p.out.at(-1)?.type === "word") {
    p.out.push(token, next);
    p.header = "body";
    i++;
  } else {
    if (token.value === "(") open(p, "(");
    if (token.value === ")") close(p, "(");
    p.out.push(token);
  }
  if (token.value === ";;" && p.cases > 0) p.pattern = true;
  p.start = true;
  p.local = false;
  return i + 1;
}

function word(tokens: Token[], i: number, p: Pass): number {
  const w = tokens[i] as WordToken;
  const bare = BARE_ASSIGNMENT.exec(w.value);
  const next = tokens[i + 1];
  if (bare && next?.type === "op" && next.value === "(") return arrayAssignment(tokens, i, bare[2] === "+", p);
  if (p.header === "name") {
    functionName(w, next, p);
    return i + 1;
  }
  if (p.awaitIn && w.value === "in" && !w.quoted) [p.awaitIn, p.pattern] = [false, true];
  else if (w.value === "esac" && !w.quoted && (p.start || p.pattern)) endCase(p);
  else if (p.start && !ASSIGNMENT_RE.test(w.value)) commandWord(tokens, i, p);
  p.out.push(p.local && APPEND_RE.test(w.value) ? withoutPlus(w) : w);
  return i + 1;
}

/** Ends `function NAME` as a command of its own, as `NAME ()` already is, so the body's first word starts a command. */
function functionName(w: WordToken, next: Token | undefined, p: Pass): void {
  p.out.push(w);
  if (next?.type !== "op" || next.value !== "(") p.out.push(SEPARATOR);
  p.header = "body";
  p.start = true;
}

function commandWord(tokens: Token[], i: number, p: Pass): void {
  const w = tokens[i] as WordToken;
  const keyword = w.quoted ? "" : w.value;
  if (keyword === "{") open(p, "{");
  else if (keyword === "}") close(p, "{");
  else p.header = keyword === "function" ? "name" : null;
  if (keyword === "case") [p.cases, p.awaitIn] = [p.cases + 1, true];
  p.start = COMMAND_STARTS.has(keyword);
  const names = localNames(tokens, i, p);
  p.local = names !== null;
  if (names) saveLocals(names, p);
}

/**
 * `esac` ends the case where bash reads it as a keyword: at a command's start or in pattern position, even
 * straight after `in`. As an argument (`echo esac`) it is a plain word; ending the case there would end it early.
 */
function endCase(p: Pass): void {
  p.cases = Math.max(0, p.cases - 1);
  p.awaitIn = false;
  p.pattern = false;
  p.start = false;
}

/** `local`, or `declare` or `typeset` without `-g` in a function body: the names it makes local, else null. */
function localNames(tokens: Token[], i: number, p: Pass): string[] | null {
  const value = (tokens[i] as WordToken).value;
  if (value !== "local" && !(LOCAL_MAKERS.has(value) && p.bodies.length > 0)) return null;
  const end = tokens.findIndex((t, j) => j > i && t.type === "op");
  const args = tokens.slice(i + 1, end < 0 ? undefined : end).filter((t): t is WordToken => t.type === "word");
  if (args.some((a) => /^-[A-Za-z]*g/.test(a.value))) return null;
  return args.flatMap((a) => DECLARED_NAME.exec(a.value)?.[1] ?? []);
}

/** Copies each name's value into a hidden variable before the declaration, for the closing brace to restore. */
function saveLocals(names: string[], p: Pass): void {
  const body = p.bodies.at(-1);
  if (body?.group !== "{" || body.parens !== p.depths["("] || names.length === 0) return;
  const saves = names.map((name) => {
    const slot = `local@${p.slots++}`;
    body.saved.push([name, slot]);
    return copyWord(slot, name);
  });
  p.out.push(...saves, SEPARATOR);
}

/** A hidden `TARGET=$SOURCE`, which takes the source's value when it is known and leaves the target unknown otherwise. */
function copyWord(target: string, source: string): WordToken {
  const value = `${target}=$${source}`;
  const ref = { name: source, start: target.length + 1, end: value.length };
  return { type: "word", value, dynamic: true, quoted: false, spliced: false, computed: false, refs: [ref], subs: [], hidden: true };
}

function open(p: Pass, group: Group): void {
  if (p.header === "body") p.bodies.push({ group, depth: p.depths[group], parens: p.depths["("], saved: [] });
  p.header = null;
  p.depths[group]++;
}

/** A `( )` body is already a subshell to the walk; a `{ }` body restores its locals, latest first. */
function close(p: Pass, group: Group): void {
  p.depths[group] = Math.max(0, p.depths[group] - 1);
  const body = p.bodies.at(-1);
  if (body?.group !== group || body.depth !== p.depths[group]) return;
  p.bodies.pop();
  p.out.push(...body.saved.reverse().map(([name, slot]) => copyWord(name, slot)));
}

function withoutPlus(w: WordToken): WordToken {
  const plus = w.value.indexOf("+=");
  const shift = (ref: VarRef): VarRef => ({ ...ref, start: ref.start - 1, end: ref.end - 1 });
  return { ...w, value: w.value.slice(0, plus) + w.value.slice(plus + 1), refs: w.refs.map(shift) };
}

/**
 * `NAME=(a b)` as one word whose value is element 0, unknown unless it is plainly literal: a brace, glob or
 * `[i]=` element can change it. An append to a variable that is not a new local keeps its element 0.
 */
function arrayAssignment(tokens: Token[], i: number, append: boolean, p: Pass): number {
  const w = tokens[i] as WordToken;
  const end = tokens.findIndex((t, j) => j > i && t.type === "op" && t.value === ")");
  const inner = tokens.slice(i + 2, end);
  if (end < 0 || inner.some((t) => t.type !== "word" && !(t.type === "op" && t.value === "\n"))) {
    p.out.push({ ...w, dynamic: true });
    return i + 1;
  }
  const elements = inner.filter((t): t is WordToken => t.type === "word");
  const name = w.value.slice(0, w.value.indexOf(append ? "+=" : "="));
  const subs = elements.flatMap((e) => e.subs);
  if (append && !p.local) p.out.push({ ...w, value: `${name}+=`, subs });
  else {
    const first = elements[0];
    const subscripted = elements.some((e) => e.value.startsWith("["));
    const known = first !== undefined && !first.dynamic && !subscripted && !/[[*?{]/.test(first.value);
    p.out.push({ ...w, value: `${name}=${first?.value ?? ""}`, dynamic: !known, refs: [], subs });
  }
  return end + 1;
}
