import type { SimpleCommand } from "../shell/commands.js";
import type { RedirectToken, WordToken } from "../shell/lexer.js";
import { basename, resolveValue } from "../shell/path.js";
import { DECLARED_RE, DECLARERS, parseAssignment } from "../shell/vars.js";
import { commandWrites, TARGET_RE } from "../shell/writers.js";
import { CURL_VALUE_OPTIONS } from "./curl-options.js";
import { HTTPIE_VALUES, wgetLongName } from "./egress.js";
import { readOptions, set, valuesOf } from "./options.js";
import { unpacks } from "./unpackers.js";
import { WGET_VALUE_OPTIONS } from "./wget-options.js";

/** Variables that choose which config file wget, curl or httpie reads. */
const CONFIG_VARS = new Set(["WGETRC", "SYSTEM_WGETRC", "CURL_HOME", "XDG_CONFIG_HOME", "HOME", "HTTPIE_CONFIG_DIR"]);
const NAMES = [...CONFIG_VARS].join("|");
/**
 * In the typed text: a prefix, compound or arithmetic assignment, whose run-time value or `(( ))` the extracted
 * commands drop, or a `${NAME:=…}` default (zsh also `${NAME::=…}`). An indirect default, bash `${!V:=…}` or zsh
 * `${(P)V:=…}`, may assign any variable whatever its name. A name after `$` is a read.
 */
const TEXT_ASSIGNS_RE = new RegExp(
  `(?<![\\w$])(?:${NAMES})\\s*(?:\\[[^\\]]*\\])?\\s*(?:<<|>>|[-+*/%&^|])?=(?!=)|(?<![\\w$])(?:${NAMES})\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*(?:${NAMES})\\b|\\$\\{(?:${NAMES})(?:\\[[^\\]]*\\])?:{0,2}=|\\$\\{(?:!|\\([^)]*P[^)]*\\))(?:\\$\\{[^}]*\\}|[^}:=])*:{0,2}=`,
);
/** In a word with quotes removed: an `env` argument. */
const WORD_ASSIGNS_RE = new RegExp(`^(?:${NAMES})\\+?=`);
/** A config file or directory: `.wgetrc`, `/etc/wgetrc`, `.curlrc`, `$XDG_CONFIG_HOME/curlrc`, `~/.config/httpie`, the legacy `~/.httpie`. */
const RC_TEXT_RE = /(?:wget|curl)rc|\/\.?httpie\b/;
/** Every name a config file, or a directory a recursive copy may plant one in, ends in. */
const RC_NAMES = [".wgetrc", "wgetrc", ".curlrc", "curlrc", "_curlrc", "config.json", "httpie", ".httpie", ".config"];
/** A declaration option that makes a nameref, through which a later plain assignment writes the named variable. */
const NAMEREF_RE = /^-[a-zA-Z]*n/;
/** Commands that write no file, whatever their operands; any other command may write any operand or attached value. */
const READ_ONLY = set("cat", "grep", "egrep", "fgrep", "rg", "ls", "echo", "printf", "test", "[", "[[", "head", "tail", "wc", "true", "false", ":", "pwd", "which", "type", "sleep", "jq", "basename", "dirname", "for", "select", "read", "mapfile", "readarray", "export", "declare", "typeset", "local", "readonly", "unset", "getopts", "let", "set", "shift", "return", "exit", "break", "continue", "wait");
/** The HTTP clients' own options that name a file they write, read against each client's value options. */
const CLIENT_OUTPUTS: Record<string, { values: ReadonlySet<string>; outputs: readonly string[] }> = {
  curl: { values: CURL_VALUE_OPTIONS, outputs: ["-o", "--output", "--output-dir", "-D", "--dump-header", "-c", "--cookie-jar", "--trace", "--trace-ascii", "--stderr", "--etag-save", "--hsts", "--alt-svc", "--libcurl"] },
  wget: { values: WGET_VALUE_OPTIONS, outputs: ["-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix", "--save-cookies", "--rejected-log", "--warc-file"] },
  http: { values: HTTPIE_VALUES, outputs: ["-o", "--output", "--session"] },
  https: { values: HTTPIE_VALUES, outputs: ["-o", "--output", "--session"] },
};
/** A file only known at run time; its `$` marks the run-time part as the lexer leaves an unexpanded variable. */
const UNKNOWN_TARGET: WordToken = { type: "word", value: "$", dynamic: true, quoted: false, spliced: false, computed: true, refs: [], subs: [] };
/** A pattern or brace character, which may expand to any name. */
const PATTERN_RE = /[*?[{]/g;
/** A `>&` or `<&` to a descriptor duplicates it and opens no file. */
const DESCRIPTOR_RE = /^(?:\d+|-)$/;

/**
 * Whether the line may choose or write the config file wget, curl or httpie reads, which can set any method and URL:
 * it writes one of `CONFIG_VARS` in any form the variable tracker knows, or a run-time name, or names an rc file
 * anywhere, or extracts an archive, whose member paths may be any file. A write target is an rc file unless its
 * literal part rules that out.
 */
export function choosesHttpConfig(src: string, commands: SimpleCommand[], home: string | null): boolean {
  if (TEXT_ASSIGNS_RE.test(src) || RC_TEXT_RE.test(src)) return true;
  return commands.some((cmd) => setsConfigVar(cmd) || unpacks(cmd) || writeTargets(cmd).some((w) => mayBeRcPath(w, cmd.dir, home)));
}

function setsConfigVar(cmd: SimpleCommand): boolean {
  if (Object.keys(cmd.env).some((k) => CONFIG_VARS.has(k)) || cmd.args.some((a) => WORD_ASSIGNS_RE.test(a.value))) return true;
  const { name, args } = cmd;
  if (name === null) return false;
  if (DECLARERS.has(name)) return declaresConfigVar(args);
  if (name === "printf") return printfSetsConfigVar(args);
  if (runTimeTarget(name, args)) return true;
  const writes = commandWrites(name, args, new Map());
  return writes === null || writes.some(([target]) => CONFIG_VARS.has(target));
}

/** A run-time word may be any assignment or option, and a nameref may later write any variable. */
function declaresConfigVar(args: WordToken[]): boolean {
  return args.some((a) => (a.dynamic && parseAssignment(a) === null) || NAMEREF_RE.test(a.value) || CONFIG_VARS.has(DECLARED_RE.exec(a.value)?.[1] ?? ""));
}

/** `printf -v NAME`; a run-time first word may itself be `-v`. */
function printfSetsConfigVar(args: WordToken[]): boolean {
  const first = args[0];
  if (!first?.value.startsWith("-v")) return first?.dynamic === true;
  const target = first.value.length > 2 ? { ...first, value: first.value.slice(2) } : args[1];
  return target === undefined || target.dynamic || CONFIG_VARS.has(TARGET_RE.exec(target.value)?.[1] ?? "");
}

/** `commandWrites` reads only literal names; a run-time one in a name slot may be any variable. */
function runTimeTarget(name: string, args: WordToken[]): boolean {
  if (name === "for" || name === "select") return args[0]?.dynamic === true;
  if (name === "getopts") return args[1]?.dynamic === true;
  return (name === "read" || name === "mapfile" || name === "readarray") && args.some((a) => a.dynamic);
}

/**
 * Files the command may write: an output redirect's target, an HTTP client's output options, and for any command not
 * `READ_ONLY` every operand and every value glued to an option or `=`. A zsh `>!` target the lexer reads as `!` is unknown.
 */
function writeTargets(cmd: SimpleCommand): WordToken[] {
  const redirected = cmd.redirects.filter(opensForWrite).flatMap((r) => (r.target?.value.startsWith("!") ? [UNKNOWN_TARGET] : (r.target ?? [])));
  if (cmd.name !== null && READ_ONLY.has(cmd.name)) return redirected;
  const client = CLIENT_OUTPUTS[cmd.name ?? ""];
  if (client) return [...redirected, ...clientOutputs(cmd, client)];
  // A null name means a run-time command word, which is args[0]: the command, not an operand it writes.
  const operands = cmd.name === null ? cmd.args.slice(1) : cmd.args;
  return [...redirected, ...operands.flatMap(withGluedValues)];
}

function clientOutputs(cmd: SimpleCommand, client: { values: ReadonlySet<string>; outputs: readonly string[] }): WordToken[] {
  const words = cmd.name === "wget" ? cmd.args.map(wgetLongName) : cmd.args.map((w) => ({ ...w, value: w.value.replace(/^--expand-/, "--") }));
  return valuesOf(readOptions(words, client.values), ...client.outputs);
}

function opensForWrite(r: RedirectToken): boolean {
  return r.op.includes(">") && !(r.op.endsWith("&") && DESCRIPTOR_RE.test(r.target?.value ?? ""));
}

/** A run-time word's tail does not depend on what precedes it; a literal one also names the text after `=` or a short option. */
function withGluedValues(w: WordToken): WordToken[] {
  if (w.dynamic) return [w];
  const eq = w.value.indexOf("=");
  const glued = eq >= 0 ? [w.value.slice(eq + 1)] : /^-[^-]./.test(w.value) ? [w.value.slice(2)] : [];
  return [w, ...glued.map((value) => ({ ...w, value }))];
}

/**
 * A run-time part may hold any text, `/` included, so the name ends in the literal text after the last one: an rc
 * name ending in it may be written, unless a `/` in it leaves a fully literal name. A literal path is resolved, and
 * a destination directory that holds rc files counts as one.
 */
function mayBeRcPath(w: WordToken, dir: string | null, home: string | null): boolean {
  const tail = w.value.slice(runTimeEnd(w));
  if (tail !== w.value) return tail.includes("/") ? isRcName(basename(tail)) : RC_NAMES.some((n) => n.endsWith(tail));
  const path = resolveValue(dir, w.value, home);
  if (path === null) return isRcName(basename(w.value));
  return RC_TEXT_RE.test(path) || rcDirs(home).includes(path);
}

function isRcName(name: string): boolean {
  return RC_NAMES.includes(name) || RC_TEXT_RE.test(name);
}

function rcDirs(home: string | null): string[] {
  return home === null ? ["/etc"] : ["/etc", home, `${home}/.config`, `${home}/.config/httpie`, `${home}/.httpie`];
}

/** Where the word's last run-time part ends: a variable, a substitution's output, another expansion or a pattern. */
function runTimeEnd(w: WordToken): number {
  const patterns = [...w.value.matchAll(PATTERN_RE)].map((m) => m.index + 1);
  const ends = [...w.refs.map((r) => r.end), ...(w.cuts ?? []).map((c) => c.at), ...expansionEnds(w), ...patterns];
  if (w.computed && ends.length === 0) return w.value.length;
  return Math.max(0, ...ends);
}

/** A computed word keeps a `${ }`, `$(( ))` or `$[ ]` as typed; each ends at its matching bracket. */
function expansionEnds(w: WordToken): number[] {
  if (!w.computed) return [];
  const ends: number[] = [];
  for (let i = w.value.indexOf("$"); i >= 0; i = w.value.indexOf("$", i + 1)) {
    if (!w.refs.some((r) => r.start <= i && i < r.end)) ends.push(bracketEnd(w.value, i + 1));
  }
  return ends;
}

function bracketEnd(value: string, open: number): number {
  const pair = { "{": "}", "(": ")", "[": "]" }[value[open] ?? ""];
  if (pair === undefined) return open;
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === value[open]) depth++;
    else if (value[i] === pair && --depth === 0) return i + 1;
  }
  return value.length;
}
