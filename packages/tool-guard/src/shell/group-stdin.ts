import { caseNamed } from "./case-script.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { printedText } from "./printed.js";
import type { Unwrapped } from "./unwrap.js";

/** An open `{ }` group or `( )` subshell, with the text each command in it prints, null when unknown. */
interface Frame {
  kind: "{" | "(";
  /** False for the `()` of a function definition, which prints nothing itself. */
  live: boolean;
  pieces: Array<string | null>;
}

interface GroupState {
  frames: Frame[];
  /** Text of a subshell closed by the previous `)`, read by the operator after it. */
  closed: string | null | undefined;
}

const states = new WeakMap<object, GroupState>();
const PIPES = new Set(["|", "|&"]);
const STDOUT_OPS = new Set([">", ">>", ">|", "<>", ">&"]);

/**
 * Text piped on from a command ending at `op`: what a `{ }` group or `( )` subshell prints when it
 * closes before a pipe (TP-1465), else `stdin`. `walk` is the key its open groups are tracked under.
 */
export function groupStdin(walk: object, op: string, words: WordToken[], redirects: RedirectToken[], cmd: Unwrapped | null, stdin: string | null): string | null {
  const state = states.get(walk) ?? { frames: [], closed: undefined };
  states.set(walk, state);
  const braces = words.findIndex((word) => !isBare(word, "{"));
  const rest = braces === -1 ? [] : words.slice(braces);
  for (let i = 0; i < words.length - rest.length; i++) state.frames.push({ kind: "{", live: true, pieces: [] });
  let closed = rest.length === 0 ? state.closed : undefined;
  state.closed = undefined;
  if (rest.length === 1 && isBare(rest[0] as WordToken, "}")) closed = close(state, "{");
  else if (cmd && !PIPES.has(op) && (cmd.name !== null || cmd.args.length > 0)) record(state, printedText(cmd.name, cmd.args));
  if (op === "(") state.frames.push({ kind: "(", live: rest.length === 0, pieces: [] });
  if (op === ")") state.closed = close(state, "(");
  if (!PIPES.has(op) || closed === undefined || closed === null || writesStdout(redirects)) return stdin;
  return closed;
}

/**
 * Redirects with a process substitution `< <(...)` read as stdin: its printed text is kept as the
 * redirect's `body`, which a shell then reads the way it reads a here-string (TP-1465).
 */
export function addRedirect(redirects: RedirectToken[], token: Token): RedirectToken[] {
  if (token.type === "redirect") return [...redirects, token];
  const last = redirects.at(-1);
  if (token.type !== "subs" || !last || last.op !== "<" || last.target !== null || last.body !== null) return redirects;
  if (last.fd !== null && last.fd !== "0") return redirects;
  const text = listText(token.subs[0] ?? []);
  return text === null ? redirects : [...redirects.slice(0, -1), { ...last, body: text }];
}

function isBare(word: WordToken, value: string): boolean {
  return word.value === value && !word.quoted && !word.dynamic;
}

function close(state: GroupState, kind: Frame["kind"]): string | null | undefined {
  const frame = state.frames.at(-1);
  if (frame?.kind !== kind) return undefined;
  state.frames.pop();
  if (!frame.live) return undefined;
  const text = joined(frame.pieces);
  record(state, text);
  return text;
}

function record(state: GroupState, text: string | null): void {
  state.frames.at(-1)?.pieces.push(text);
}

/** Every command's text in order when all are known, else the last known one, as a group or subshell prints it. */
function joined(pieces: Array<string | null>): string | null {
  if (pieces.length > 0 && pieces.every((piece) => piece !== null)) return pieces.join("");
  return [...pieces].reverse().find((piece) => piece !== null) ?? null;
}

/** The text a process substitution's commands print; a command piped on to another is left out. */
function listText(tokens: Token[]): string | null {
  const pieces: Array<string | null> = [];
  let words: WordToken[] = [];
  for (const token of [...tokens, null]) {
    if (token?.type === "word") words.push(token);
    if (token !== null && token.type !== "op") continue;
    const cmd = caseNamed(words)[0];
    if (cmd && (cmd.name !== null || cmd.args.length > 0) && !PIPES.has(token?.value ?? "")) pieces.push(printedText(cmd.name, cmd.args));
    words = [];
  }
  return joined(pieces);
}

function writesStdout(redirects: RedirectToken[]): boolean {
  return redirects.some((r) => r.op.startsWith("&>") || (STDOUT_OPS.has(r.op) && (r.fd === null || r.fd === "1")));
}
