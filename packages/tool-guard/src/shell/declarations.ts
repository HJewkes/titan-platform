import type { OpToken, Token, VarRef, WordToken } from "./lexer.js";
import { ASSIGNMENT_RE } from "./vars.js";

const LOCAL_MAKERS = new Set(["local", "declare", "typeset"]);
const COMMAND_STARTS = new Set(["{", "then", "do", "else", "elif", "if", "while", "until", "!"]);
const BARE_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=$/;
const APPEND_RE = /^[A-Za-z_][A-Za-z0-9_]*\+=/;

type Group = "{" | "(";

interface Pass {
  out: Token[];
  /** The next word starts a command. */
  start: boolean;
  /** `function` was read and its name is next, or `NAME ()` or `function NAME` was read and its body is next. */
  header: "name" | "body" | null;
  depths: Record<Group, number>;
  /** Open function bodies, each with the depth of its group outside it. */
  bodies: Array<{ group: Group; depth: number }>;
  /** The command makes a new local, so an append in it starts from empty. */
  local: boolean;
}

/**
 * Rewrites the assignments variable tracking cannot read word by word: `NAME=(a b)` becomes `NAME=a`,
 * the element 0 that `$NAME` reads, and an append that makes a new function local loses its `+`.
 */
export function normalizeDeclarations(tokens: Token[]): Token[] {
  const p: Pass = { out: [], start: true, header: null, depths: { "{": 0, "(": 0 }, bodies: [], local: false };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as Token;
    if (token.type === "op") i = op(tokens, i, p);
    else if (token.type === "word") i = word(tokens, i, p);
    else p.out.push(tokens[i++] as Token);
  }
  return p.out;
}

function op(tokens: Token[], i: number, p: Pass): number {
  const token = tokens[i] as OpToken;
  const next = tokens[i + 1];
  if (token.value === "(" && next?.type === "op" && next.value === ")" && p.out.at(-1)?.type === "word") {
    p.out.push(token, next);
    p.header = "body";
    i++;
  } else {
    if (token.value === "(") open(p, "(");
    if (token.value === ")") close(p, "(");
    p.out.push(token);
  }
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
  if (p.start && !ASSIGNMENT_RE.test(w.value)) commandWord(w, p);
  else if (p.local && /^-[A-Za-z]*g/.test(w.value)) p.local = false;
  p.out.push(p.local && APPEND_RE.test(w.value) ? withoutPlus(w) : w);
  return i + 1;
}

/** Ends `function NAME` as a command of its own, as `NAME ()` already is, so the body's first word starts a command. */
function functionName(w: WordToken, next: Token | undefined, p: Pass): void {
  p.out.push(w);
  if (next?.type !== "op" || next.value !== "(") p.out.push({ type: "op", value: ";" });
  p.header = "body";
  p.start = true;
}

/** `declare -g` and `export` stay global; `local`, and `declare` or `typeset` in a function body, make a local. */
function commandWord(w: WordToken, p: Pass): void {
  const keyword = w.quoted ? "" : w.value;
  if (keyword === "{") open(p, "{");
  else if (keyword === "}") close(p, "{");
  else p.header = keyword === "function" ? "name" : null;
  p.start = COMMAND_STARTS.has(keyword);
  p.local = w.value === "local" || (LOCAL_MAKERS.has(w.value) && p.bodies.length > 0);
}

function open(p: Pass, group: Group): void {
  if (p.header === "body") p.bodies.push({ group, depth: p.depths[group] });
  p.header = null;
  p.depths[group]++;
}

function close(p: Pass, group: Group): void {
  p.depths[group] = Math.max(0, p.depths[group] - 1);
  const body = p.bodies.at(-1);
  if (body?.group === group && body.depth === p.depths[group]) p.bodies.pop();
}

function withoutPlus(w: WordToken): WordToken {
  const plus = w.value.indexOf("+=");
  const shift = (ref: VarRef): VarRef => ({ ...ref, start: ref.start - 1, end: ref.end - 1 });
  return { ...w, value: w.value.slice(0, plus) + w.value.slice(plus + 1), refs: w.refs.map(shift) };
}

/**
 * `NAME=(a b)` as one word whose value is element 0, unknown unless it is plainly literal.
 * An append to a variable that is not a new local keeps the element 0 it has, so it appends nothing.
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
    const known = first !== undefined && !first.dynamic && !/[[*?]/.test(first.value);
    p.out.push({ ...w, value: `${name}=${first?.value ?? ""}`, dynamic: !known, refs: [], subs });
  }
  return end + 1;
}
