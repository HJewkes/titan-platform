import { isCaseUnsure } from "../shell/case-attrs.js";
import type { SimpleCommand } from "../shell/commands.js";
import { splits } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import type { ClassifyContext } from "../types.js";
import { CURL_SWITCHES, CURL_VALUE_OPTIONS } from "./curl-options.js";
import { expandCurlGlob } from "./curl-glob.js";
import { curlBodies } from "./curl-bodies.js";
import { firstExpansion } from "./github-endpoint.js";
import { hasFlag, lastValue, readOptions, set, valuesOf } from "./options.js";
import type { Option, Options } from "./options.js";
import { WGET_SWITCHES, WGET_VALUE_OPTIONS, WGETRC_BODY, WGETRC_NO_OPS } from "./wget-options.js";

const CURL_BODY = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"];
/** curl's value options, and the `--expand-<option>` form of each long one. */
const CURL_READ_VALUES = set(...CURL_VALUE_OPTIONS, ...[...CURL_VALUE_OPTIONS].filter((f) => f.startsWith("--")).map((f) => `--expand-${f.slice(2)}`));
/** Options that set the method or URL from somewhere the line does not show. */
const CURL_HIDDEN = set("-K", "--config", "--request-target");
const WGET_HIDDEN = set("--config");
/** curl's switches, with `--include`: an old name `--help all` no longer lists for a renamed switch. */
const CURL_KNOWN_SWITCHES = set(...CURL_SWITCHES, "--include");
/** Words that start curl's next request, which takes its own method and URLs. */
const CURL_NEXT = set("--next", "-:");
/** Long wget option names getopt_long matches by unique prefix: each listed one, and each switch with and without `no-`. */
const WGET_LONG = set(...[...WGET_VALUE_OPTIONS, ...WGET_SWITCHES].filter((n) => n.startsWith("--")).flatMap((n) => [n, ...switchForms(n, WGET_SWITCHES)]));
export const HTTPIE_VALUES = set("-a", "--auth", "-A", "--auth-type", "-o", "--output", "--session", "--session-read-only", "-p", "--print", "-s", "--style", "--pretty", "--verify", "--cert", "--cert-key", "--timeout", "--proxy", "--raw", "--format-options", "--default-scheme");
/** An httpie request item; the earliest separator decides its kind. */
const HTTPIE_ITEM_RE = /==|:=@|:=|=@|=|@|:/;
const HTTPIE_METHODS = set("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");

/** A URL the request goes to that the command line does not show: read from a file, appended by xargs or set by a config file. */
const UNSEEN_URL: WordToken = { type: "word", value: "", typed: "", dynamic: true, quoted: false, spliced: false, computed: true, refs: [], subs: [], cuts: [] };

/** A method known only at run time: a dynamic or case-unsure `-X`, or one a config file or raw request target may set. */
export const UNKNOWN_METHOD = "UNKNOWN";

export interface HttpRequest {
  method: string;
  body: boolean;
  /** The literal body texts sent, or null when any part comes from a file or is only known at run time. */
  bodies: string[] | null;
  urls: WordToken[];
}

/**
 * The request `curl`, `wget`, `http` or `https` would send, or null for any other command. What the
 * command line does not show fails closed: a run-time method is a write and an unseen URL is run-time.
 */
export function httpRequest(cmd: SimpleCommand, ctx?: ClassifyContext): HttpRequest | null {
  const request = clientRequest(cmd);
  if (!request) return null;
  if (ctx?.httpConfigUnseen) return { ...request, method: UNKNOWN_METHOD, bodies: null, urls: [...request.urls, UNSEEN_URL] };
  const unseen = request.urls.length === 0 || cmd.wrapping.includes("xargs");
  return unseen ? { ...request, urls: [...request.urls, UNSEEN_URL] } : request;
}

function clientRequest(cmd: SimpleCommand): HttpRequest | null {
  if (cmd.name === "curl") return curlRequest(cmd.args);
  if (cmd.name === "wget") return wgetRequest(cmd);
  if (cmd.name === "http" || cmd.name === "https") return httpieRequest(readOptions(cmd.args, HTTPIE_VALUES));
  return null;
}

export const isWrite = (method: string) => method !== "GET" && method !== "HEAD";

const methodOf = (word: WordToken | null) => (word === null ? null : word.dynamic || isCaseUnsure(word) ? UNKNOWN_METHOD : word.value.toUpperCase());

/** Each `--next` request reads alone; parts that disagree on the method make it unknown for the line. */
function curlRequest(args: WordToken[]): HttpRequest {
  const parts: WordToken[][] = [[]];
  for (const word of args.flatMap(splitNext)) {
    if (word === null) parts.push([]);
    else parts.at(-1)?.push(word);
  }
  const requests = parts.map((part, i) => curlPart(part, i < parts.length - 1));
  const filled = requests.filter((_, i) => (parts[i]?.length ?? 0) > 0);
  const methods = new Set((filled.length > 0 ? filled : requests).map((r) => r.method));
  const [only] = methods;
  return {
    method: methods.size === 1 && only !== undefined ? only : UNKNOWN_METHOD,
    body: requests.some((r) => r.body),
    bodies: requests.some((r) => r.bodies === null) ? null : requests.flatMap((r) => r.bodies ?? []),
    urls: requests.flatMap((r) => r.urls),
  };
}

/**
 * An option the reader does not know, a config file, a raw request target or a templated `--expand-*` value leaves the
 * method unknown and adds a URL known only at run time; a templated `--url` is itself that URL.
 */
function curlPart(words: WordToken[], followed: boolean): HttpRequest {
  const o = curlOptions(words);
  const body = hasFlag(o, ...CURL_BODY);
  const upload = hasFlag(o, "-T", "--upload-file");
  const implied = switchOn(o, "-G", "--get") ? "GET" : upload ? "PUT" : body ? "POST" : "GET";
  const unknown = o.opts.some((opt) => !isKnownOption(opt.flag, CURL_VALUE_OPTIONS, CURL_KNOWN_SWITCHES, CURL_HIDDEN));
  const hidden = unknown || o.opts.some((opt) => opt.templated && opt.flag !== "--url") || hidesOption(words, o.positionals, followed);
  const runTimeUrl = o.opts.some((opt) => opt.templated && opt.flag === "--url");
  const method = hidden || runTimeUrl ? UNKNOWN_METHOD : (methodOf(lastValue(o, "-X", "--request")) ?? implied);
  const globs = switchOn(o, "-g", "--globoff") ? (u: WordToken) => [u] : globUrls;
  const urls = [...o.positionals, ...valuesOf(o, "--url")].flatMap(globs);
  const bodies = hidden ? null : curlBodies(o, CURL_BODY);
  return { method, body, bodies, urls: hidden ? [...urls, UNSEEN_URL] : urls };
}

interface CurlOption extends Option {
  /** An `--expand-*` value holding `{{` or only known at run time; its value is already a run-time word. */
  templated: boolean;
}

/** curl reads `--expand-<opt>` as `<opt>` with each `{{var}}` in its value filled in at run time. */
function curlOptions(words: WordToken[]): { opts: CurlOption[]; positionals: WordToken[] } {
  const raw = readOptions(words, CURL_READ_VALUES);
  return { opts: raw.opts.map(normalizedOption), positionals: raw.positionals };
}

function normalizedOption(opt: Option): CurlOption {
  if (!opt.flag.startsWith("--expand-")) return { ...opt, templated: false };
  const flag = `--${opt.flag.slice("--expand-".length)}`;
  const literal = opt.value !== null && !opt.value.dynamic && !opt.value.value.includes("{{");
  if (literal || opt.value === null) return { flag, value: opt.value, templated: false };
  return { flag, value: runtimeWord(opt.value), templated: true };
}

function runtimeWord(base: WordToken): WordToken {
  return { ...base, value: "", typed: "", dynamic: true, refs: [], subs: [], cuts: [] };
}

/**
 * `--next`, `-:` and a short cluster's `:` (`-s:`) start the next request, shown as null; a letter that
 * takes a value ends the cluster, so a `:` after it is part of that value.
 */
function splitNext(word: WordToken): Array<WordToken | null> {
  if (CURL_NEXT.has(word.value)) return [null];
  const v = word.value;
  if (!/^-[^-]/.test(v) || !v.includes(":")) return [word];
  const out: Array<WordToken | null> = [];
  let letters = "";
  const flush = () => {
    if (letters !== "") out.push({ ...word, value: `-${letters}` });
    letters = "";
  };
  for (let i = 1; i < v.length; i++) {
    if (CURL_VALUE_OPTIONS.has(`-${v[i]}`)) return [...out, { ...word, value: `-${letters}${v.slice(i)}` }];
    if (v[i] === ":") {
      flush();
      out.push(null);
    } else letters += v[i];
  }
  flush();
  return out;
}

/** A run-time word may be an option when it can split into several words, or nothing but a `-` comes before its run-time part. */
export function mayBeOption(word: WordToken): boolean {
  if (!word.dynamic) return false;
  if (splitsWords(word)) return true;
  const prefix = word.value.slice(0, firstExpansion(word));
  return prefix === "" || prefix.startsWith("-");
}

/** Unquoted expansions split, and so do `"$@"` and `"${A[@]}"` quoted. */
function splitsWords(word: WordToken): boolean {
  return splits(word) || word.refs.some((r) => r.name === "@" || r.name === "*") || /\$\{[^}]*(?:@|\[\*\])/.test(word.value);
}

/**
 * A positional the reader takes for a URL that may be an option instead hides the request: one that splits,
 * or one followed by a word or a request boundary it could take as its value. A lone last one reads as a URL.
 */
function hidesOption(words: WordToken[], positionals: WordToken[], followed: boolean): boolean {
  return positionals.some((p) => mayBeOption(p) && (splitsWords(p) || followed || words.indexOf(p) < words.length - 1));
}

/** A listed option, or a switch's other form; an option that reads settings from a file the line does not show is not known. */
function isKnownOption(flag: string, values: ReadonlySet<string>, switches: ReadonlySet<string>, hidden: ReadonlySet<string>): boolean {
  if (hidden.has(flag)) return false;
  if (values.has(flag) || switches.has(flag)) return true;
  return flag.startsWith("--") && switchForms(flag, switches).length > 0;
}

/** The other form of a long switch: `--no-x` for `--x` and `--x` for `--no-x`, when that one is listed. */
function switchForms(flag: string, switches: ReadonlySet<string>): string[] {
  const other = flag.startsWith("--no-") ? `--${flag.slice("--no-".length)}` : `--no-${flag.slice(2)}`;
  return switches.has(other) ? [other] : [];
}

/** Whether a switch is on: the last of it and its `--no-` form wins. */
function switchOn(o: Options, short: string, long: string): boolean {
  const off = `--no-${long.slice(2)}`;
  const last = o.opts.filter((opt) => opt.flag === short || opt.flag === long || opt.flag === off).at(-1);
  return last !== undefined && last.flag !== off;
}

/** A glob curl cannot expand here is a run-time URL; a dynamic word keeps its own reading only when its literal lead holds no glob. */
function globUrls(word: WordToken): WordToken[] {
  const cut = word.dynamic ? word.value.search(/[$`]/) : -1;
  const literal = cut >= 0 ? word.value.slice(0, cut) : word.value;
  const urls = expandCurlGlob(literal);
  if (!urls) return [runtimeWord(word)];
  if (!word.dynamic) return urls.map((value) => ({ ...word, value }));
  return urls.length === 1 && urls[0] === literal ? [word] : [runtimeWord(word)];
}

/** An unknown option or an unread `-e` command may set the method and URLs, so the request is unknown. */
function wgetRequest(cmd: SimpleCommand): HttpRequest {
  const words = cmd.args.map(wgetLongName);
  const o = readOptions(words, WGET_VALUE_OPTIONS);
  const settings = wgetSettings(o);
  const hidden = settings === null || hidesOption(words, o.positionals, false);
  const method = hidden ? UNKNOWN_METHOD : settings.method;
  const listed = hasFlag(o, "-i", "--input-file") || hidden ? [UNSEEN_URL] : [];
  return { method, body: settings?.body ?? false, bodies: hidden ? null : wgetBodies(o), urls: [...o.positionals, ...listed] };
}

/** A body an `-e` command sets is not read, so it makes the texts unknown, as a file or run-time text does. */
function wgetBodies(o: Options): string[] | null {
  const texts = valuesOf(o, "--post-data", "--body-data");
  if (hasFlag(o, "--post-file", "--body-file", "-e", "--execute") || texts.some((t) => t.dynamic)) return null;
  return texts.map((t) => t.value);
}

/** getopt_long takes any unique prefix of a long option, as `--meth` for `--method`. */
export function wgetLongName(word: WordToken): WordToken {
  const eq = word.value.indexOf("=");
  const name = eq < 0 ? word.value : word.value.slice(0, eq);
  if (!name.startsWith("--") || name === "--" || WGET_LONG.has(name)) return word;
  const [only, ...more] = [...WGET_LONG].filter((n) => n.startsWith(name));
  return only === undefined || more.length > 0 ? word : { ...word, value: `${only}${eq < 0 ? "" : word.value.slice(eq)}` };
}

/** The method and body wget's options and `-e` commands set, the last winning; null when one may set anything else. */
function wgetSettings(o: Options): { method: string; body: boolean } | null {
  let method: string | null = null;
  let body = false;
  for (const opt of o.opts) {
    const setting = isKnownOption(opt.flag, WGET_VALUE_OPTIONS, WGET_SWITCHES, WGET_HIDDEN) ? wgetSetting(opt) : null;
    if (setting === null) return null;
    if (setting.name === "method") method = setting.value;
    else if (WGETRC_BODY.has(setting.name)) body = true;
  }
  return { method: method ?? (body ? "POST" : "GET"), body };
}

/** An option as the wgetrc setting it makes; `-e` runs one by name, which is case-, `-` and `_`-insensitive. */
function wgetSetting(opt: Option): { name: string; value: string | null } | null {
  if (opt.flag !== "-e" && opt.flag !== "--execute") return { name: wgetrcName(opt.flag), value: methodOf(opt.value) };
  const command = opt.value;
  const eq = command?.value.indexOf("=") ?? -1;
  if (!command || command.dynamic || eq < 0) return null;
  const name = wgetrcName(command.value.slice(0, eq));
  if (WGETRC_NO_OPS.has(name)) return { name, value: null };
  if (name !== "method" && !WGETRC_BODY.has(name)) return null;
  return { name, value: command.value.slice(eq + 1).trim().toUpperCase() };
}

const wgetrcName = (text: string) => text.replace(/[-_\s]/g, "").toLowerCase();

/** `http [METHOD] URL [ITEM...]`; `key=value`, `key:=json` and `key@file` items make a body, headers and `==` queries do not. */
function httpieRequest(o: Options): HttpRequest {
  const [first, ...rest] = o.positionals;
  const explicit = first && isHttpieMethod(first, rest[0]) ? methodOf(first) : null;
  const [url, ...items] = explicit ? rest : o.positionals;
  const body = hasFlag(o, "--raw") || items.some((i) => isBodyItem(i.value));
  return { method: explicit ?? (body ? "POST" : "GET"), body, bodies: body ? null : [], urls: url ? [url] : [] };
}

/** httpie takes an upper-case first word as the method, and a method name in any case or a run-time word when a URL, not an item, follows. */
function isHttpieMethod(first: WordToken, next: WordToken | undefined): boolean {
  if (!first.dynamic && /^[A-Z]+$/.test(first.value)) return true;
  if (!first.dynamic && !HTTPIE_METHODS.has(first.value.toUpperCase())) return false;
  const sep = next && !next.dynamic ? HTTPIE_ITEM_RE.exec(next.value)?.[0] : undefined;
  return next !== undefined && (sep === undefined || sep === ":");
}

function isBodyItem(item: string): boolean {
  const sep = HTTPIE_ITEM_RE.exec(item)?.[0];
  return sep !== undefined && sep !== "==" && sep !== ":";
}

