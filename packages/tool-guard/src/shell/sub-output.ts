import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { shellReading } from "./named-fd.js";
import { printedOutput } from "./printed.js";
import type { Shell } from "./printed.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";
import { mayGenerate } from "./word-generation.js";

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
  return splice(word, cuts, shell, false) ?? "";
}

/** `strict` leaves the word unknown (null) when any substitution in it prints text that is not wholly known. */
function splice(word: WordToken, cuts: NonNullable<WordToken["cuts"]>, shell: Shell, strict: boolean): string | null {
  let value = "";
  let last = 0;
  for (const { at, sub } of cuts) {
    const tokens = word.subs[sub];
    const printed = tokens ? walkSub(tokens, shell) : null;
    const output = printed?.text ?? "";
    // bash and dash drop a NUL from a substitution's output and zsh keeps it, so no one text is what runs.
    if (strict && (!printed?.complete || output.includes("\0"))) return null;
    value += word.value.slice(last, at) + output.replaceAll("\0", "").replace(/\n+$/, "");
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

/**
 * A word of substitutions alone, spliced. An unquoted one is split on the shell's IFS and globbed against the directory,
 * neither of which the line can say, so its words are left unknown.
 */
function splitSplice(arg: WordToken, shell: Shell): WordToken[] | null {
  if (!arg.cuts || arg.refs.length > 0 || arg.unquotedExpansion) return null;
  const value = splice(arg, arg.cuts, shell, true);
  return value === null ? null : [{ ...arg, dynamic: false, cuts: undefined, subs: [], value }];
}

/**
 * The text `shell` prints, with a `{name}` before a redirect read as that shell reads it; a whole line runs under one
 * shell, so each shell's outputs make one reading together. A list, group, subshell or pipeline prints what its
 * commands print in order, where a pipeline's later stages pass text through only for `cat` and `tee` (TP-3333).
 * The text is complete only for a body built wholly from what the walk models: printers joined by `;`, newline and
 * `|`, in groups that open where a command starts. Anything else may run a command more than once, skip it, or stop
 * the body, so the text is then one reading of the output and not all of it.
 */
function walkSub(tokens: Token[], shell: Shell): { text: string | null; complete: boolean } {
  const walk: SubWalk = { frames: [{ kind: "(", pieces: [] }], current: undefined, piped: null, unknown: false };
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  let expands = false;
  for (const token of [...tokens, null]) {
    if (token?.type === "word") words.push(token);
    if (token?.type === "redirect") redirects.push(token);
    if (token?.type === "subs") expands = true;
    if (token !== null && token.type !== "op") continue;
    // A `(` after a word defines a function, whose body runs only where it is called.
    if (token?.value === "(" && (words.length > 0 || redirects.length > 0)) walk.unknown = true;
    stage(walk, words, redirects, expands, shell);
    endStage(walk, token?.value ?? ";");
    words = [];
    redirects = [];
    expands = false;
  }
  closeOpenFrames(walk);
  const pieces = walk.frames[0]?.pieces ?? [];
  return { text: pieces.length > 0 ? pieces.join("") : null, complete: !walk.unknown };
}

/** A group still open at the end, as zsh closes `{ echo a }`, keeps its text in the reading but not as all of it. */
function closeOpenFrames(walk: SubWalk): void {
  while (walk.frames.length > 1) {
    walk.unknown = true;
    const text = closeFrame(walk, walk.frames.at(-1)?.kind ?? "(");
    if (text !== null) walk.frames.at(-1)?.pieces.push(text);
  }
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
  /** A stage ran whose output is not known, so the text walked is only part of what the body prints. */
  unknown: boolean;
}

/**
 * The commands whose output the walk models, as a stage's first word. Any other, a keyword such as `if` or `!` and a
 * wrapper such as `exec` among them, may print anything or change which commands run after it.
 */
const PRINTERS = new Set(["echo", "printf", "cat", "tee"]);

/** Runs one command's words: opens the groups it starts, closes one it ends, or prints what it prints. */
function stage(walk: SubWalk, rawWords: WordToken[], rawRedirects: RedirectToken[], expands: boolean, shell: Shell): void {
  // Words straight after a group's `)` are not a separate command the walk has seen run.
  if (walk.current !== undefined && rawWords.length > 0) walk.unknown = true;
  const { words, redirects } = shellReading(rawWords, rawRedirects, shell);
  const open = words.findIndex((word) => !isBare(word, "{"));
  const rest = open === -1 ? [] : words.slice(open);
  for (let i = 0; i < words.length - rest.length; i++) pushFrame(walk, "{");
  // A brace or glob may expand into other words, so the text on the line is only one reading of what is printed.
  if (rest.some(mayGenerate)) walk.unknown = true;
  const [first] = rest;
  const closes = first !== undefined && rest.length === 1 && isBare(first, "}");
  if (closes) walk.current = closeFrame(walk, "{");
  else if (rest.length > 0) walk.current = expands ? null : commandStage(rest, redirects, walk.piped, shell);
  // `$(<f)` prints the file, which is only known at run time.
  else if (redirects.length > 0) walk.current = null;
  // The text stays a reading for eval and -c, which only add readings, while the body is not known whole.
  if (first && !closes && !isPrinter(first)) walk.unknown = true;
  if (writesStdout(redirects)) walk.unknown = true;
}

const STDOUT_OPS = new Set([">", ">>", ">|", ">&"]);

/**
 * A redirect that sends the stage's stdout somewhere other than the substitution; the text stays as one reading. A
 * `{name}` before a writing redirect counts whichever shell reads it as the descriptor: dash and sh keep it a word
 * and redirect stdout.
 */
function writesStdout(redirects: RedirectToken[]): boolean {
  return redirects.some((r) => {
    if (r.op.startsWith("&>")) return true;
    if (r.named !== undefined) return STDOUT_OPS.has(r.op);
    return (STDOUT_OPS.has(r.op) && (r.fd === null || r.fd === "1")) || (r.op === "<>" && r.fd === "1");
  });
}

function isPrinter(word: WordToken): boolean {
  return PRINTERS.has(word.value) && !word.quoted && !word.dynamic;
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

/** Operators the walk models; `&&`, `||`, `&`, `;;` and `|&` depend on exit status, timing or stderr. */
const WALKED_OPS = new Set([";", "\n", "|", "(", ")"]);

/** Finishes the stage at the operator `op`: a pipe hands its text on, any other separator keeps it in the open group. */
function endStage(walk: SubWalk, op: string): void {
  if (!WALKED_OPS.has(op)) walk.unknown = true;
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
  if (walk.current === null) walk.unknown = true;
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
