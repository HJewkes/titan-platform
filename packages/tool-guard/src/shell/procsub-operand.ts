import { listText } from "./group-stdin.js";
import { SHELLS } from "./inline-script.js";
import type { Inline } from "./inline-script.js";
import type { Token, WordToken } from "./lexer.js";
import { pipedShellTexts } from "./piped-nul.js";
import { resolvePath } from "./path.js";
import { shellOperands } from "./shell-options.js";
import type { SimpleCommand } from "./commands.js";
import type { ScriptTarget } from "../scripts.js";
import type { Unwrapped } from "./unwrap.js";
import { ReadingLimitError, UnreadableScriptError } from "./unsure-readings.js";

/** The descriptor path a real shell passes for a `<( )` operand. Only its being a descriptor the line did not open matters. */
const PROCSUB_PATH = "/dev/fd/63";
const SOURCERS = new Set(["source", "."]);
/** Texts a body may print; the same cap `group-stdin.ts` puts on a group. */
const MAX_TEXTS = 16;

/**
 * The operand `bash <(...)` hands the shell: a path to the substitution's output. A substitution at a command's
 * operand position becomes this word, which only shells and sourcers keep (`withoutProcsub`), so no other command's
 * arguments change. A substitution a redirect awaits (`bash < <(...)`, `cmd > >(...)`) belongs to that redirect.
 */
export function withProcsub(words: WordToken[], before: Token | undefined, token: Token): WordToken[] {
  if (token.type !== "subs" || words.length === 0) return words;
  // The lexer leaves a `<` or `>` pending past a `<( )`, so the next word, even after `;`, may already be its target.
  if (before?.type === "redirect" && before.body === null) return words;
  const operand: WordToken = { type: "word", value: PROCSUB_PATH, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [], procsub: token.subs };
  return [...words, operand];
}

function keepsProcsub(name: string | null): boolean {
  return name !== null && (SHELLS.has(name) || SOURCERS.has(name));
}

/** The command as recorded: a substitution operand stays only where the command may run it as a script. */
export function withoutProcsub<T extends Pick<Unwrapped, "name" | "args">>(cmd: T): T {
  if (keepsProcsub(cmd.name) || !cmd.args.some((word) => word.procsub !== undefined)) return cmd;
  return { ...cmd, args: cmd.args.filter((word) => word.procsub === undefined) };
}

/** The substitution a shell or `source` runs as its script, not as a positional parameter (`bash -s <(...)`, `bash -c STR <(...)`). */
function scriptOperand(cmd: Pick<Unwrapped, "name" | "args">): Token[] | null {
  if (cmd.name === null) return null;
  if (SOURCERS.has(cmd.name)) return cmd.args[0]?.procsub?.[0] ?? null;
  if (!SHELLS.has(cmd.name)) return null;
  const { hasC, positional } = shellOperands(cmd.args, cmd.name);
  return hasC ? null : (positional?.procsub?.[0] ?? null);
}

/** The command as main saw it: no substitution operand, so a trailing operand is the script and `<` still feeds stdin. */
export function withoutProcsubOperands<T extends Pick<Unwrapped, "name" | "args">>(cmd: T): T {
  return { ...cmd, args: cmd.args.filter((word) => word.procsub === undefined) };
}

/** Whether the command runs a `<( )` as its script, which `scriptTargets` then settles. */
export function hasProcsubOperand(cmd: Pick<Unwrapped, "name" | "args">): boolean {
  return scriptOperand(cmd) !== null;
}

/**
 * The text a body prints when it is echo or printf, read as the shell's script, and with it whatever main read from the
 * command without the substitution (`-c STR` after it is a positional the body may relay as `"$@"`). A body the guard
 * does not model (another program's output) adds no text, as the same body piped into the shell adds none.
 */
export function procsubScript<T extends Pick<Unwrapped, "name" | "args">>(cmd: T, rest: (plain: T) => Inline | null): Inline | null {
  const body = scriptOperand(cmd);
  if (body === null) return null;
  const per = listText(body);
  const all = per.some((texts) => texts === null) ? [] : [...new Set(per.flatMap((texts) => texts ?? []))];
  if (all.length > MAX_TEXTS) throw new ReadingLimitError();
  const texts = [...all.flatMap((text) => pipedShellTexts(cmd.name, text)), ...(rest(withoutProcsubOperands(cmd))?.texts ?? [])];
  return texts.length === 0 ? null : { texts, wrap: "heredoc-shell" };
}

/**
 * The script a `<( )` operand reads when its body is a single `cat FILE`: that file. Echo and printf text is walked
 * from `procsubScript`, and any other body is left as the same body piped into the shell is, so neither adds a target.
 * A file the line names but cannot be resolved is refused, as the guard cannot read it.
 */
export function procsubTargets(cmd: SimpleCommand, home: string): ScriptTarget[] {
  const body = scriptOperand(cmd) ?? [];
  const cat = procsubFile(body);
  return (cat === null ? redirectedFiles(body) : [cat]).map((file) => {
    const path = resolvePath(cmd.dir, file, home);
    if (path === null) throw new UnreadableScriptError(null);
    return { path, kind: "shell" };
  });
}

const GROUP_WORDS = new Set(["{", "}", "!"]);

/** The file of each nameless `< FILE` command in the body, wherever it sits: zsh's NULLCMD prints it into the script. */
function redirectedFiles(body: Token[]): WordToken[] {
  const commands: Token[][] = [[]];
  for (const token of body) {
    if (token.type === "op") commands.push([]);
    else commands.at(-1)?.push(token);
  }
  return commands.flatMap((tokens) => {
    const named = tokens.some((token) => token.type === "word" && !(GROUP_WORDS.has(token.value) && !token.quoted));
    const redirects = tokens.filter((token) => token.type === "redirect");
    return named || redirects.length === 0 ? [] : [redirectedFile(redirects)];
  });
}

/** One `< FILE`; any other nameless redirect is refused as unreadable. */
function redirectedFile(redirects: Token[]): WordToken {
  const [only] = redirects;
  const target = redirects.length === 1 && only?.type === "redirect" && only.op === "<" && (only.fd === null || only.fd === "0") ? only.target : null;
  if (target === null || target.dynamic || target.computed || target.subs.length > 0) throw new UnreadableScriptError(null);
  return target;
}

function procsubFile(body: Token[]): WordToken | null {
  const words = body.every((token) => token.type === "word") ? body : [];
  const [name, ...rest] = words;
  if (name?.value !== "cat" || name.quoted || name.dynamic) return null;
  const operands = rest[0]?.value === "--" && !rest[0].quoted ? rest.slice(1) : rest;
  const [file] = operands;
  if (operands.length !== 1 || file === undefined) return null;
  const literal = !file.dynamic && !file.computed && file.subs.length === 0;
  return literal && (operands.length !== rest.length || !file.value.startsWith("-")) ? file : null;
}
