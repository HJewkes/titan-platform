import type { SimpleCommand } from "./shell/commands.js";
import type { RedirectToken, WordToken } from "./shell/lexer.js";
import { containsGuarded, expandHome, hasGlob, matchGlob, matchGuarded, toAbsolute } from "./paths.js";
import type { GuardedList } from "./paths.js";
import { resolveFrom } from "./shell/path.js";
import type { ClassifyContext } from "./types.js";

/** Where in a command a guarded path appeared. `inline` is program text an interpreter runs. */
export type Site = "arg" | "assignment" | "redirect-in" | "redirect-out" | "here-string" | "inline";

/** How the path matched: as typed, as a glob, through a symlink, by a distinctive file name, or as a directory holding one. */
export type Via = "path" | "glob" | "symlink" | "basename" | "contains";

export interface Mention {
  /** The guarded entry id, or `basename:<name>`. */
  id: string;
  site: Site;
  via: Via;
  /** The argument it came from, null for redirects, assignments and script text. */
  word: WordToken | null;
}

export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
export const INTERPRETERS: ReadonlySet<string> = new Set(["python", "python3", "node", "perl", "ruby", "osascript", "deno"]);

const INPUT_OPS = new Set(["<", "<&"]);
const HEREDOC_OPS = new Set(["<<", "<<-"]);
const FILE_URL_RE = /\bfile:\/\/(?=\/)/gi;
const REMOTE_URL_RE = /^[a-z][\w+.-]*:\/\//i;
const REMOTE_URL_GLOBAL_RE = /\b[a-z][\w+.-]*:\/\/[^\s'"`]*/gi;
const PATH_IN_TEXT_RE =/(?<=^|[\s'"`;|&<>(),=:[{])(?:~|\$HOME|\$\{HOME\})?\/[^\s'"`;|&<>(),\]}]*/g;

type Found = Omit<Mention, "site" | "word">;

interface Scan {
  dir: string | null;
  ctx: ClassifyContext;
  list: GuardedList;
  /** Also match a directory that holds a guarded path, for commands that read recursively. */
  contains: boolean;
}

/** Every guarded path `cmd` names in its arguments, literal assignments and redirections. */
export function commandMentions(cmd: SimpleCommand, ctx: ClassifyContext, list: GuardedList, contains = false): Mention[] {
  const scan: Scan = { dir: cmd.dir, ctx, list, contains };
  const argSite: Site = cmd.name !== null && INTERPRETERS.has(cmd.name) ? "inline" : "arg";
  const out: Mention[] = [];
  for (const word of cmd.args) out.push(...wordMentions(word.value, scan).map((m) => ({ ...m, site: argSite, word })));
  for (const value of Object.values(cmd.env)) out.push(...at(wordMentions(value, scan), "assignment"));
  for (const r of cmd.redirects) out.push(...redirectMentions(cmd.name, r, scan));
  return out;
}

/** Guarded paths a tool's path argument names; a Grep also matches a directory holding one. */
export function pathMentions(path: string, cwd: string | null, ctx: ClassifyContext, list: GuardedList, contains: boolean): Mention[] {
  const scan: Scan = { dir: cwd, ctx, list, contains };
  return at(uniqueById(toAbsolute(path, cwd, ctx.home).map((p) => matchLiteralOrLink(p, scan))), "arg");
}

function redirectMentions(name: string | null, r: RedirectToken, scan: Scan): Mention[] {
  const shell = name !== null && SHELLS.has(name);
  const interpreter = name !== null && INTERPRETERS.has(name);
  if (HEREDOC_OPS.has(r.op)) return interpreter && r.body !== null ? at(textMentions(r.body, scan), "inline") : [];
  if (!r.target || /^(\d+|-)$/.test(r.target.value)) return [];
  if (r.op === "<<<") {
    if (shell) return [];
    return at(wordMentions(r.target.value, scan), interpreter ? "inline" : "here-string");
  }
  return at(wordMentions(r.target.value, scan), INPUT_OPS.has(r.op) ? "redirect-in" : "redirect-out");
}

function at(found: Found[], site: Site): Mention[] {
  return found.map((m) => ({ ...m, site, word: null }));
}

/** Mentions in one word: the word as a path, an `--opt=value` value, and paths embedded in its text. */
function wordMentions(raw: string, scan: Scan): Found[] {
  const value = raw.replace(FILE_URL_RE, "");
  if (value === "" || REMOTE_URL_RE.test(value)) return [];
  const candidates = new Set<string>();
  if (!value.startsWith("-")) for (const p of toAbsolute(value, scan.dir, scan.ctx.home)) candidates.add(p);
  const eq = /^--[\w-]+=(.+)$/.exec(value);
  if (eq) for (const p of toAbsolute(eq[1] as string, scan.dir, scan.ctx.home)) candidates.add(p);
  const found = [...candidates].map((p) => matchPath(p, scan));
  return withBasenames(found, value, scan);
}

/** Mentions in program text: embedded absolute or home paths, then distinctive file names. */
function textMentions(text: string, scan: Scan): Found[] {
  return withBasenames([], text, scan);
}

/** Adds paths embedded in `text`; with no path match, falls back to distinctive file names. */
function withBasenames(found: Array<Found | null>, text: string, scan: Scan): Found[] {
  const local = localText(text);
  const embedded = [...local.matchAll(PATH_IN_TEXT_RE)].map((m) => resolveFrom("/", expandHome(m[0], scan.ctx.home)));
  const all = uniqueById([...found, ...embedded.map((p) => matchPath(p, scan))]);
  return all.length > 0 ? all : basenameMentions(local, scan.list);
}

/** A remote URL's path names no local file, so URLs are dropped; a `file://` URL keeps its path. */
function localText(text: string): string {
  return text.replace(FILE_URL_RE, "").replace(REMOTE_URL_GLOBAL_RE, " ");
}

function matchPath(path: string, scan: Scan): Found | null {
  if (hasGlob(path)) return found(matchGlob(path, scan.list, scan.ctx.home), "glob");
  return matchLiteralOrLink(path, scan);
}

function matchLiteralOrLink(path: string, scan: Scan): Found | null {
  const direct = matchLiteral(path, scan);
  if (direct) return direct;
  const real = safeReadLink(scan.ctx, path);
  if (real === null || real === path) return null;
  const linked = matchLiteral(real, scan);
  return linked && { ...linked, via: "symlink" };
}

function matchLiteral(path: string, scan: Scan): Found | null {
  const direct = found(matchGuarded(path, scan.list, scan.ctx.home), "path");
  if (direct || !scan.contains) return direct;
  return found(containsGuarded(path, scan.list, scan.ctx.home), "contains");
}

function found(entry: { id: string } | null, via: Via): Found | null {
  return entry ? { id: entry.id, via } : null;
}

function safeReadLink(ctx: ClassifyContext, path: string): string | null {
  try {
    return ctx.readLink(path);
  } catch {
    return null;
  }
}

function basenameMentions(text: string, list: GuardedList): Found[] {
  return list.basenames
    .filter((name) => new RegExp(`(?<![\\w.-])${name.replace(/[.-]/g, "\\$&")}(?![\\w.-])`).test(text))
    .map((name) => ({ id: `basename:${name}`, via: "basename" }));
}

function uniqueById(found: Array<Found | null>): Found[] {
  const seen = new Map<string, Found>();
  for (const f of found) if (f && !seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}
