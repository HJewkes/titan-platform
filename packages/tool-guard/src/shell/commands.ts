import { ParseError, tokenize } from "./lexer.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";
import { expandWord, lookup, trackVars } from "./vars.js";
import type { Vars } from "./vars.js";

const MAX_DEPTH = 8;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/** One simple command the shell would run. */
export interface SimpleCommand {
  /** Null when no word names the command statically: only assignments or redirections, or a dynamic first word. */
  name: string | null;
  args: WordToken[];
  /** Literal `NAME=value` prefixes. */
  env: Record<string, string>;
  redirects: RedirectToken[];
  /** Working directory, null when it cannot be known. */
  dir: string | null;
}

export interface ExtractOptions {
  cwd?: string | null;
  /** Expands `~`, `$HOME` and a bare `cd`; null leaves them unknown. */
  home?: string | null;
}

interface Scope {
  dir: string | null;
  vars: Vars;
}

interface Walk {
  scope: Scope;
  stack: Scope[];
  out: SimpleCommand[];
  home: string | null;
  depth: number;
}

/**
 * Every simple command the shell would run, including ones nested in substitutions, `bash -c`
 * strings, `eval` and heredocs fed to a shell. Literal variable assignments are expanded into
 * later words. Throws `ParseError`.
 */
export function extractCommands(src: string, options: ExtractOptions = {}): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const scope = { dir: options.cwd ?? null, vars: new Map() };
  walk(tokenize(src), { scope, stack: [], out, home: options.home ?? null, depth: 0 });
  return out;
}

function walk(tokens: Token[], w: Walk): void {
  if (w.depth > MAX_DEPTH) throw new ParseError("nesting too deep");
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  for (const token of tokens) {
    if (token.type === "op") {
      emit(words, redirects, w);
      words = [];
      redirects = [];
      scope(token.value, w);
      continue;
    }
    if (token.type === "word") words.push(token);
    if (token.type === "redirect") redirects.push(token);
    for (const sub of nestedLists(token)) walk(sub, child(w));
  }
  emit(words, redirects, w);
}

function nestedLists(token: Token): Token[][] {
  if (token.type === "redirect") return [...(token.target?.subs ?? []), ...token.subs];
  return token.type === "op" ? [] : token.subs;
}

function child(w: Walk): Walk {
  return { ...w, scope: { dir: w.scope.dir, vars: new Map(w.scope.vars) }, stack: [], depth: w.depth + 1 };
}

function scope(op: string, w: Walk): void {
  if (op === "(") {
    w.stack.push(w.scope);
    w.scope = { dir: w.scope.dir, vars: new Map(w.scope.vars) };
  }
  if (op === ")") w.scope = w.stack.pop() ?? w.scope;
}

function emit(rawWords: WordToken[], rawRedirects: RedirectToken[], w: Walk): void {
  const expand = (word: WordToken) => expandWord(word, (name) => lookup(w.scope.vars, w.home, name));
  const redirects = rawRedirects.map((r) => (r.target ? { ...r, target: expand(r.target) } : r));
  const cmd = unwrap(rawWords.map(expand));
  if (!cmd) return;
  if (cmd.name === null && cmd.args.length === 0) {
    for (const [name, value] of cmd.assigned) w.scope.vars.set(name, value);
    if (redirects.length === 0) return;
  }
  if (cmd.name === "cd" || cmd.name === "pushd") {
    w.scope.dir = changeDir(w.scope.dir, cmd.args.find((a) => a.value === "-" || !a.value.startsWith("-")), w.home);
    return;
  }
  if (cmd.name !== null) trackVars(cmd.name, cmd.args, w.scope.vars);
  w.out.push({ name: cmd.name, args: cmd.args, env: literalEnv(cmd), redirects, dir: w.scope.dir });
  const script = inlineScript(cmd, redirects);
  if (script !== null) walk(tokenize(script), child(w));
}

function literalEnv(cmd: Unwrapped): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of cmd.assigned) if (value !== null) env[name] = value;
  return env;
}

/** The script text a shell or `eval` runs: a `-c` string, or a heredoc or here-string on stdin. */
function inlineScript(cmd: Unwrapped, redirects: RedirectToken[]): string | null {
  if (cmd.script !== undefined) return cmd.script;
  if (cmd.name === "eval") return cmd.args.map((a) => a.value).join(" ");
  if (cmd.name === null || !SHELLS.has(cmd.name)) return null;
  const { hasC, positional } = shellOperands(cmd.args);
  if (hasC) return positional?.value ?? null;
  return positional ? null : stdinScript(redirects);
}

function shellOperands(args: WordToken[]): { hasC: boolean; positional: WordToken | null } {
  let hasC = false;
  for (let i = 0; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (v === "-") break;
    if (v === "--") return { hasC, positional: args[i + 1] ?? null };
    if (SHELL_VALUE_OPTS.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (/^[-+][A-Za-z]+$/.test(v)) hasC ||= v.startsWith("-") && v.includes("c");
    else return { hasC, positional: args[i] as WordToken };
  }
  return { hasC, positional: null };
}

function stdinScript(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  if (!feed) return null;
  return feed.body ?? feed.target?.value ?? null;
}

function changeDir(dir: string | null, word: WordToken | undefined, home: string | null): string | null {
  if (!word) return home;
  return word.value === "-" ? null : resolvePath(dir, word, home);
}
