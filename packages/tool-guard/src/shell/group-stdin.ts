import { caseNamed } from "./case-script.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { namedFdReadings } from "./named-fd.js";
import { printedText } from "./printed.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/** Every text one command, or a run of them, may print under its readings; null when any is unknown. */
type Texts = string[] | null;

/** An open `{ }` group or `( )` subshell, with the texts each command in it prints. */
interface Frame {
  kind: "{" | "(";
  /** False for the `()` of a function definition, which prints nothing itself. */
  live: boolean;
  pieces: Texts[];
}

interface GroupState {
  frames: Frame[];
  /** Texts of a subshell closed by the previous `)`, read by the operator after it. */
  closed: Texts | undefined;
}

/** Texts one group may print; a line whose `{name}` readings would multiply past it is refused unchecked. */
const MAX_TEXTS = 16;

const states = new WeakMap<object, GroupState>();

/** Copies one walk's open `{ }` and `( )` frames to a fork of it, so the fork pipes on a group that opened before the split. */
export function copyGroupState(from: object, to: object): void {
  const state = states.get(from);
  if (state) states.set(to, { closed: state.closed, frames: state.frames.map((frame) => ({ ...frame, pieces: [...frame.pieces] })) });
}
const PIPES = new Set(["|", "|&"]);
const STDOUT_OPS = new Set([">", ">>", ">|", "<>", ">&"]);

/**
 * Every text a `{ }` group or `( )` subshell may print when it closes before a pipe at `op` (TP-1465), under each
 * reading of each command in it (TP-3308); undefined when the pipe takes what the command itself prints. `walk` is the
 * key its open groups are tracked under; `readings` are the command's, one per shell reading of its `{name}` words.
 */
export function groupStdin(walk: object, op: string, words: WordToken[], redirects: RedirectToken[], readings: ReadonlyArray<Unwrapped | null>): string[] | undefined {
  const state = states.get(walk) ?? { frames: [], closed: undefined };
  states.set(walk, state);
  const braces = words.findIndex((word) => !isBare(word, "{"));
  const rest = braces === -1 ? [] : words.slice(braces);
  for (let i = 0; i < words.length - rest.length; i++) state.frames.push({ kind: "{", live: true, pieces: [] });
  let closed = rest.length === 0 ? state.closed : undefined;
  state.closed = undefined;
  if (rest.length === 1 && isBare(rest[0] as WordToken, "}")) closed = close(state, "{");
  else if (!PIPES.has(op)) record(state, printedPiece(readings));
  if (op === "(") state.frames.push({ kind: "(", live: rest.length === 0, pieces: [] });
  if (op === ")") state.closed = close(state, "(");
  if (!PIPES.has(op) || !closed || writesStdout(redirects)) return undefined;
  return closed;
}

/**
 * Each distinct text the command's readings print, "" for a reading that runs no command; null when any reading's text
 * is unknown, undefined when no reading runs one.
 */
function printedPiece(readings: ReadonlyArray<Unwrapped | null>): Texts | undefined {
  const runs = readings.filter((cmd): cmd is Unwrapped => cmd !== null && (cmd.name !== null || cmd.args.length > 0));
  if (runs.length === 0) return undefined;
  const texts = runs.map((cmd) => printedText(cmd.name, cmd.args)).filter((text) => text !== null);
  if (texts.length < runs.length) return null;
  if (runs.length < readings.length) texts.push("");
  return [...new Set(texts)];
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
  const texts = listText(token.subs[0] ?? []);
  // A body is one text, so output that differs by `{name}` reading is left unknown, which a shell reading it refuses.
  const body = texts?.length === 1 ? texts[0] : undefined;
  return body === undefined ? redirects : [...redirects.slice(0, -1), { ...last, body }];
}

function isBare(word: WordToken, value: string): boolean {
  return word.value === value && !word.quoted && !word.dynamic;
}

function close(state: GroupState, kind: Frame["kind"]): Texts | undefined {
  const frame = state.frames.at(-1);
  if (frame?.kind !== kind) return undefined;
  state.frames.pop();
  if (!frame.live) return undefined;
  const text = joined(frame.pieces);
  record(state, text);
  return text;
}

function record(state: GroupState, texts: Texts | undefined): void {
  if (texts !== undefined) state.frames.at(-1)?.pieces.push(texts);
}

/**
 * Every combination of the commands' texts in order when all are known, else the last known one's, as a group or
 * subshell prints it.
 */
function joined(pieces: Texts[]): Texts {
  const known = pieces.filter((piece) => piece !== null);
  if (known.length === 0 || known.length < pieces.length) return known.at(-1) ?? null;
  let texts = [""];
  for (const piece of known) {
    texts = [...new Set(texts.flatMap((head) => piece.map((tail) => head + tail)))];
    if (texts.length > MAX_TEXTS) throw new ReadingLimitError();
  }
  return texts;
}

/** The texts a process substitution's commands print; a command piped on to another is left out. */
function listText(tokens: Token[]): Texts {
  const pieces: Texts[] = [];
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  for (const token of [...tokens, null]) {
    if (token?.type === "word") words.push(token);
    if (token?.type === "redirect") redirects.push(token);
    if (token !== null && token.type !== "op") continue;
    const readings = namedFdReadings(words, redirects)?.map((reading) => reading.words) ?? [words];
    const piece = PIPES.has(token?.value ?? "") ? undefined : printedPiece(readings.map((each) => caseNamed(each)[0] ?? null));
    if (piece !== undefined) pieces.push(piece);
    words = [];
    redirects = [];
  }
  return joined(pieces);
}

function writesStdout(redirects: RedirectToken[]): boolean {
  return redirects.some((r) => r.op.startsWith("&>") || (STDOUT_OPS.has(r.op) && (r.fd === null || r.fd === "1")));
}
