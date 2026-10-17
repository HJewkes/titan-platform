import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { shellReading } from "./named-fd.js";
import { printedOutput } from "./printed.js";
import type { Shell } from "./printed.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";

/** Either may run the line, and their builtins print some of the same arguments differently. */
export const SPLICING_SHELLS: readonly Shell[] = ["bash", "zsh"];

/**
 * The words with each command substitution's output spliced in where the substitution sits, as `eval` and `-c` read
 * them under `shell`. Output is known when literal on the line: one `echo` or `printf` with static arguments, or one
 * `cat` reading a heredoc or here-string. Any other substitution prints text only known at run time and splices in
 * nothing.
 */
export function splicedWords(words: WordToken[], shell: Shell): WordToken[] {
  return words.map((word) => (word.cuts ? { ...word, value: spliced(word, word.cuts, shell) } : word));
}

function spliced(word: WordToken, cuts: NonNullable<WordToken["cuts"]>, shell: Shell): string {
  return splice(word, cuts, shell, () => "") ?? "";
}

function splice(word: WordToken, cuts: NonNullable<WordToken["cuts"]>, shell: Shell, unknown: () => string | null): string | null {
  let value = "";
  let last = 0;
  for (const { at, sub } of cuts) {
    const tokens = word.subs[sub];
    const output = (tokens ? subOutput(tokens, shell) : null) ?? unknown();
    if (output === null) return null;
    value += word.value.slice(last, at) + output.replace(/\n+$/, "");
    last = at;
  }
  return value + word.value.slice(last);
}

/**
 * `args` with every substitution's output spliced in as static words, or null when any argument is dynamic for another
 * reason or any substitution prints text only known at run time, so a caller reading the text keeps its unknown case.
 */
export function knownSplice(args: WordToken[], shell: Shell): WordToken[] | null {
  const known: WordToken[] = [];
  for (const arg of args) {
    const words = arg.dynamic ? splitSplice(arg, shell) : [arg];
    if (words === null) return null;
    known.push(...words);
  }
  return known;
}

/** A word of substitutions alone, spliced; an unquoted one is split on blanks as the shell splits it (globs are not modelled). */
function splitSplice(arg: WordToken, shell: Shell): WordToken[] | null {
  if (!arg.cuts || arg.refs.length > 0) return null;
  const value = splice(arg, arg.cuts, shell, () => null);
  if (value === null) return null;
  const literal = { ...arg, dynamic: false, cuts: undefined, subs: [] };
  if (!arg.unquotedExpansion) return [{ ...literal, value }];
  if (arg.cuts.length !== 1 || arg.value !== "") return null;
  return value.split(/\s+/).filter((part) => part !== "").map((part) => ({ ...literal, value: part, unquotedExpansion: undefined }));
}

/**
 * The text `shell` prints, with a `{name}` before a redirect read as that shell reads it; a whole line runs under one
 * shell, so each shell's outputs make one reading together. A list, group, subshell or pipeline prints what its
 * commands print in order, where a pipeline's later stages pass text through only for `cat` and `tee` (TP-3333).
 */
function subOutput(tokens: Token[], shell: Shell): string | null {
  const walk: SubWalk = { frames: [{ kind: "(", pieces: [] }], current: undefined, piped: null };
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  let expands = false;
  for (const token of [...tokens, null]) {
    if (token?.type === "word") words.push(token);
    if (token?.type === "redirect") redirects.push(token);
    if (token?.type === "subs") expands = true;
    if (token !== null && token.type !== "op") continue;
    stage(walk, words, redirects, expands, shell);
    endStage(walk, token?.value ?? ";");
    words = [];
    redirects = [];
    expands = false;
  }
  while (walk.frames.length > 1) closeFrame(walk, walk.frames.at(-1)?.kind ?? "(");
  const text = walk.frames[0]?.pieces.join("") ?? "";
  return walk.frames[0]?.pieces.length ? text : null;
}

/** An open `{ }` group or `( )` subshell with the texts of the commands finished in it. */
interface Frame {
  kind: "{" | "(";
  pieces: string[];
}

interface SubWalk {
  frames: Frame[];
  /** What the current pipeline stage prints: null when unknown, undefined before the stage has run. */
  current: string | null | undefined;
  /** What the stage before the current one prints into it. */
  piped: string | null;
}

/** Runs one command's words: opens the groups it starts, closes one it ends, or prints what it prints. */
function stage(walk: SubWalk, rawWords: WordToken[], rawRedirects: RedirectToken[], expands: boolean, shell: Shell): void {
  const { words, redirects } = shellReading(rawWords, rawRedirects, shell);
  const open = words.findIndex((word) => !isBare(word, "{"));
  const rest = open === -1 ? [] : words.slice(open);
  for (let i = 0; i < words.length - rest.length; i++) pushFrame(walk, "{");
  const [first] = rest;
  if (first && rest.length === 1 && isBare(first, "}")) walk.current = closeFrame(walk, "{");
  else if (rest.length > 0) walk.current = expands ? null : commandStage(rest, redirects, walk.piped, shell);
}

function isBare(word: WordToken, value: string): boolean {
  return word.value === value && !word.quoted && !word.dynamic;
}

function commandStage(words: WordToken[], redirects: RedirectToken[], piped: string | null, shell: Shell): string | null {
  const cmd = unwrap(words);
  if (!cmd) return null;
  const printed = cmd.name === "printf" ? printedOutput(cmd.name, cmd.args, shell) : commandOutput(cmd.name, cmd.args, redirects, shell);
  return printed ?? (passesThrough(cmd, redirects) ? piped : null);
}

/** `tee` and a `cat` reading only the pipe print what is piped in; a stdin redirect replaces the pipe. */
function passesThrough(cmd: Unwrapped, redirects: RedirectToken[]): boolean {
  if (redirects.some((r) => r.op.startsWith("<") && (r.fd === null || r.fd === "0"))) return false;
  return cmd.name === "tee" || (cmd.name === "cat" && readsOnlyStdin(cmd.args));
}

function pushFrame(walk: SubWalk, kind: Frame["kind"]): void {
  walk.frames.push({ kind, pieces: [] });
  walk.piped = null;
}

/** Finishes the stage at the operator `op`: a pipe hands its text on, any other separator keeps it in the open group. */
function endStage(walk: SubWalk, op: string): void {
  if (op === "|" || op === "|&") {
    walk.piped = walk.current ?? null;
    walk.current = undefined;
    return;
  }
  commit(walk);
  if (op === "(") pushFrame(walk, "(");
  if (op === ")") walk.current = closeFrame(walk, "(");
}

function commit(walk: SubWalk): void {
  if (typeof walk.current === "string") walk.frames.at(-1)?.pieces.push(walk.current);
  walk.current = undefined;
  walk.piped = null;
}

/** The text of the group `kind` closes, null when nothing in it has known output or it was not open. */
function closeFrame(walk: SubWalk, kind: Frame["kind"]): string | null {
  const frame = walk.frames.at(-1);
  if (frame?.kind !== kind || walk.frames.length < 2) return null;
  walk.frames.pop();
  return frame.pieces.length > 0 ? frame.pieces.join("") : null;
}

/**
 * The text one unwrapped command prints under `shell` when it is literal on the line, else null. It keeps the newline
 * `echo` and a here-string end with, which a file the output is written to holds and a substitution strips.
 */
export function commandOutput(name: string | null, args: WordToken[], redirects: RedirectToken[], shell: Shell): string | null {
  if (name === "cat") return readsOnlyStdin(args) ? literalStdin(redirects) : null;
  // Bash's echo prints `\0043` as written where zsh's decodes it, and escapes are modelled for neither shell alone.
  if (args.some((a) => a.value.includes("\\"))) return null;
  return printedOutput(name, args, shell);
}

function readsOnlyStdin(args: WordToken[]): boolean {
  return !args.some((a) => a.dynamic) && catOperands(args.map((a) => a.value)).every((v) => v === "-");
}

/** A here-string's word is literal only when it expands nothing; a heredoc body only once the shell has processed it. */
function literalStdin(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  if (!feed || feed.target === null) return null;
  if (feed.op === "<<<") return feed.target.dynamic ? null : `${feed.target.value}\n`;
  return feed.target.quoted ? feed.body : unquotedBody(feed.body ?? "");
}

/**
 * An unquoted-delimiter heredoc body as the shell feeds it: a backslash before `\`, `$`, a backquote or a newline is
 * removed, any other stays. An unescaped `$` or backquote expands at run time, which leaves the text unknown.
 */
function unquotedBody(body: string): string | null {
  const escape = /\\([\\$`\n])/g;
  if (/[$`]/.test(body.replace(escape, ""))) return null;
  return body.replace(escape, (_: string, escaped: string) => (escaped === "\n" ? "" : escaped));
}

/** `cat`'s file operands; `-` reads stdin and counts as one. */
export function catOperands(values: string[]): string[] {
  const end = values.indexOf("--");
  const options = end < 0 ? values : values.slice(0, end);
  const operands = options.filter((v) => v === "-" || !v.startsWith("-"));
  return end < 0 ? operands : [...operands, ...values.slice(end + 1)];
}

/** The text a heredoc or here-string feeds the command, the last one winning. */
export function stdinScript(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  if (!feed) return null;
  return feed.body ?? feed.target?.value ?? null;
}
