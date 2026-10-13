import type { SimpleCommand } from "../shell/commands.js";
import { isCaseUnsure } from "../shell/case-attrs.js";
import { parseGit } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { expandCurlGlob } from "./curl-glob.js";
import { hasFlag, lastValue, readOptions, set, valuesOf } from "./options.js";
import type { Option, Options } from "./options.js";

/** Hosts data may be sent to (D5). `registry.npmjs.org` is allowed for reads only, so it is absent. */
const ALLOWED_HOSTS = set("github.com", "api.github.com", "localhost", "127.0.0.1", "::1");
/** A host only known at run time; never allowed. */
const UNKNOWN = "unknown";
const UPLOAD_METHODS = set("POST", "PUT", "PATCH");

const CURL_BODY = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"];
const CURL_PLAIN_VALUES = [...CURL_BODY, "-X", "--request", "-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "--retry", "-K", "--config", "--cacert", "--cert", "-E", "--key", "-r", "--range", "-C", "--continue-at", "-D", "--dump-header", "--resolve", "--connect-to", "--url", "--oauth2-bearer", "--unix-socket", "--output-dir", "--variable", "--request-target"];
/** curl 8.3's `--expand-<option>` takes the same value as `<option>`, after `{{name}}` substitution. */
const CURL_VALUES = set(...CURL_PLAIN_VALUES, ...CURL_PLAIN_VALUES.filter((f) => f.startsWith("--")).map((f) => `--expand-${f.slice(2)}`));
/** Inputs that make curl's method and URL unknowable from the line: a config file and a raw request target. */
const CURL_HIDDEN = set("-K", "--config", "--request-target");
const WGET_BODY = ["--post-data", "--post-file", "--body-data", "--body-file"];
const WGET_VALUES = set(...WGET_BODY, "--method", "-O", "--output-document", "-o", "--output-file", "-a", "-e", "-U", "--user-agent", "-t", "-T", "-w", "-P", "-i", "--header");
const HTTPIE_VALUES = set("-a", "--auth", "-A", "--auth-type", "-o", "--output", "--session", "--session-read-only", "-p", "--print", "-s", "--style", "--pretty", "--verify", "--cert", "--cert-key", "--timeout", "--proxy", "--raw", "--format-options", "--default-scheme");
/** An httpie request item; the earliest separator decides its kind. */
const HTTPIE_ITEM_RE = /==|:=@|:=|=@|=|@|:/;

/** A method known only at run time: a dynamic `-X`, or one a config file or raw request target may set. */
export const UNKNOWN_METHOD = "UNKNOWN";

export interface HttpRequest {
  method: string;
  body: boolean;
  /** The literal body texts sent, or null when any part comes from a file or is only known at run time. */
  bodies: string[] | null;
  urls: WordToken[];
}

/** The request `curl`, `wget`, `http` or `https` would send, or null for any other command. */
export function httpRequest(cmd: SimpleCommand): HttpRequest | null {
  if (cmd.name === "curl") return curlRequest(cmd.args);
  if (cmd.name === "wget") return wgetRequest(readOptions(cmd.args, WGET_VALUES));
  if (cmd.name === "http" || cmd.name === "https") return httpieRequest(readOptions(cmd.args, HTTPIE_VALUES));
  return null;
}

/** A hidden input makes the method unknown and adds one URL word known only at run time. */
function curlRequest(args: WordToken[]): HttpRequest {
  const o = expandedOptions(readOptions(args, CURL_VALUES));
  const hidden = o.opts.find((opt) => CURL_HIDDEN.has(opt.flag) || opt.flag.startsWith("--expand-"));
  const body = hasFlag(o, ...CURL_BODY);
  const urls = curlUrls(o);
  if (hidden) return { method: UNKNOWN_METHOD, body, bodies: curlBodies(o), urls: [...urls, runtimeUrl(hidden.value ?? (args[0] as WordToken))] };
  const explicit = lastValue(o, "-X", "--request");
  return { method: explicit ? explicitMethod(explicit) : curlImpliedMethod(o, body), body, bodies: curlBodies(o), urls };
}

/** `--expand-<option>` with a literal value and no `{{` reads as `<option>`; any other keeps its name, which marks it hidden. */
function expandedOptions(o: Options): Options {
  const plain = (opt: Option): Option =>
    opt.flag.startsWith("--expand-") && opt.value && !opt.value.dynamic && !opt.value.value.includes("{{") ? { ...opt, flag: `--${opt.flag.slice("--expand-".length)}` } : opt;
  return { opts: o.opts.map(plain), positionals: o.positionals };
}

/** `-G` makes every part a GET only when no `-:`/`--next` splits the line, as options are read across parts. */
function curlImpliedMethod(o: Options, body: boolean): string {
  if (hasFlag(o, "-G", "--get") && !hasFlag(o, "-:", "--next")) return "GET";
  if (hasFlag(o, "-T", "--upload-file")) return "PUT";
  return body ? "POST" : "GET";
}

function explicitMethod(word: WordToken): string {
  return word.dynamic || isCaseUnsure(word) ? UNKNOWN_METHOD : word.value.toUpperCase();
}

function runtimeUrl(base: WordToken): WordToken {
  return { ...base, value: "", typed: "", dynamic: true, refs: [], subs: [], cuts: [] };
}

/** curl globs each URL itself unless `-g`/`--globoff`; a glob it cannot expand here is a run-time URL. */
function curlUrls(o: Options): WordToken[] {
  const words = [...o.positionals, ...valuesOf(o, "--url")];
  return hasFlag(o, "-g", "--globoff") ? words : words.flatMap(globUrls);
}

/** A dynamic word keeps its own reading only when its literal lead holds no glob. */
function globUrls(word: WordToken): WordToken[] {
  const cut = word.dynamic ? word.value.search(/[$`]/) : -1;
  const literal = cut >= 0 ? word.value.slice(0, cut) : word.value;
  const urls = expandCurlGlob(literal);
  if (!urls) return [runtimeUrl(word)];
  if (!word.dynamic) return urls.map((value) => ({ ...word, value }));
  return urls.length === 1 && urls[0] === literal ? [word] : [runtimeUrl(word)];
}

function curlBodies(o: Options): string[] | null {
  const texts: string[] = [];
  for (const opt of o.opts.filter((x) => CURL_BODY.includes(x.flag))) {
    const text = curlBodyText(opt);
    if (text === null) return null;
    texts.push(text);
  }
  return texts;
}

function curlBodyText({ flag, value }: Option): string | null {
  if (!value || value.dynamic || flag === "-T" || flag === "--upload-file") return null;
  return curlReadsFile(flag, value.value) ? null : value.value;
}

/** `@file` loads a file except under `--data-raw`; `--data-urlencode` reads `name@file`; a form field reads `=@file` and `=<file`. */
function curlReadsFile(flag: string, text: string): boolean {
  if (flag === "--data-raw" || flag === "--form-string") return false;
  if (flag === "-F" || flag === "--form") return /=[@<]/.test(text);
  if (flag !== "--data-urlencode") return text.startsWith("@");
  const at = text.indexOf("@");
  const eq = text.indexOf("=");
  return at >= 0 && (eq < 0 || at < eq);
}

function wgetRequest(o: Options): HttpRequest {
  const body = hasFlag(o, ...WGET_BODY);
  const explicit = lastValue(o, "--method");
  return { method: explicit ? explicitMethod(explicit) : body ? "POST" : "GET", body, bodies: wgetBodies(o), urls: o.positionals };
}

function wgetBodies(o: Options): string[] | null {
  const texts = valuesOf(o, "--post-data", "--body-data");
  if (hasFlag(o, "--post-file", "--body-file") || texts.some((t) => t.dynamic)) return null;
  return texts.map((t) => t.value);
}

/** `http [METHOD] URL [ITEM...]`; `key=value`, `key:=json` and `key@file` items make a body, headers and `==` queries do not. */
function httpieRequest(o: Options): HttpRequest {
  const [first, ...rest] = o.positionals;
  const explicit = first && /^[A-Z]+$/.test(first.value) ? first.value : null;
  const [url, ...items] = explicit ? rest : o.positionals;
  const body = hasFlag(o, "--raw") || items.some((i) => isBodyItem(i.value));
  return { method: explicit ?? (body ? "POST" : "GET"), body, bodies: body ? null : [], urls: url ? [url] : [] };
}

function isBodyItem(item: string): boolean {
  const sep = HTTPIE_ITEM_RE.exec(item)?.[0];
  return sep !== undefined && sep !== "==" && sep !== ":";
}

/** Host a URL word names, lowercased; `unknown` when the host part is only known at run time. */
export function hostOf(word: WordToken): string {
  const cut = word.dynamic ? word.value.search(/[$`]/) : -1;
  const literal = cut >= 0 ? word.value.slice(0, cut) : word.value;
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(literal) ? literal : `http://${literal.replace(/^:/, "localhost:")}`;
  if (word.dynamic && !/^[a-z][\w+.-]*:\/\/[^/]+\//i.test(withScheme)) return UNKNOWN;
  try {
    return new URL(withScheme).hostname.replace(/^\[|\]$/g, "").toLowerCase() || UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

const allowed = (host: string) => ALLOWED_HOSTS.has(host);

function actionsFor(spelling: SpellingId, hosts: string[]): ClassifiedAction[] {
  return [...new Set(hosts)].filter((h) => !allowed(h)).map((host) => classified(spelling, { host }));
}

const HTTP_SPELLINGS: Record<string, SpellingId> = {
  curl: "bash.egress.curl-upload",
  wget: "bash.egress.wget-upload",
  http: "bash.egress.httpie",
  https: "bash.egress.httpie",
};

function upload(cmd: SimpleCommand): ClassifiedAction[] {
  const request = httpRequest(cmd);
  if (!request || !(request.body || UPLOAD_METHODS.has(request.method))) return [];
  return actionsFor(HTTP_SPELLINGS[cmd.name ?? ""] as SpellingId, request.urls.map(hostOf));
}

const GH_GIST_WRITES = set("create", "new", "edit");

function gist(cmd: SimpleCommand): ClassifiedAction[] {
  const [group, verb] = readOptions(cmd.args, set("-d", "--desc", "-f", "--filename", "-a", "--add", "-r", "--remove")).positionals;
  if (group?.value !== "gist" || !verb || !GH_GIST_WRITES.has(verb.value)) return [];
  return [classified("bash.egress.gh-gist", { host: "gist.github.com" })];
}

const NC_VALUES = set("-p", "-s", "-w", "-i", "-x", "-X", "-e", "-c", "-W", "-q", "-T", "-O", "-I", "-V", "-M", "-m", "-P", "-G", "-g");
const TELNET_VALUES = set("-l", "-n", "-e", "-b", "-k", "-X");
/** socat address types that name a remote host first: `TCP:host:port`, `OPENSSL:host:port`. */
const SOCAT_REMOTE_RE = /^(?:tcp[46]?|udp[46]?|sctp[46]?|openssl|ssl|socks4a?|socks5|proxy)(?:-connect|-sendto|-datagram)?:([^:,]+)/i;

function socketHosts(cmd: SimpleCommand): string[] {
  if (cmd.name === "socat") {
    return readOptions(cmd.args, set("-d", "-lf", "-b", "-t", "-T")).positionals.flatMap((a) => socatHost(a));
  }
  const values = cmd.name === "telnet" ? TELNET_VALUES : NC_VALUES;
  const hosts = readOptions(cmd.args, values).positionals.filter((a) => a.dynamic || !/^\d+(-\d+)?$/.test(a.value));
  return (cmd.name === "telnet" ? hosts.slice(0, 1) : hosts).map(hostOf);
}

function socatHost(address: WordToken): string[] {
  if (address.dynamic) return [UNKNOWN];
  const host = SOCAT_REMOTE_RE.exec(address.value)?.[1];
  return host === undefined ? [] : [host.toLowerCase()];
}

const SOCKETS = set("nc", "ncat", "netcat", "socat", "telnet");

function socket(cmd: SimpleCommand): ClassifiedAction[] {
  return SOCKETS.has(cmd.name ?? "") ? actionsFor("bash.egress.raw-socket", socketHosts(cmd)) : [];
}

const SCP_VALUES = set("-P", "-i", "-o", "-F", "-c", "-l", "-S", "-J", "-D", "-X", "-b", "-B", "-R", "-s");
const RSYNC_VALUES = set("-e", "--rsh", "-f", "--filter", "-B", "-T", "-M", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "--password-file", "--port", "--backup-dir", "--suffix", "--temp-dir", "--chmod", "--chown", "--timeout", "--log-file", "--partial-dir", "--compare-dest", "--copy-dest", "--link-dest", "--max-size", "--min-size", "--bwlimit", "--out-format");
/** `host:path`, `user@host:path` or `host::module`: a colon before any slash. */
const REMOTE_PATH_RE = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:[\]]+):/;

/** The host a copy operand names, or null for a local path. */
function remoteHost(word: WordToken): string | null {
  if (/^[a-z][\w+.-]*:\/\//i.test(word.value)) return hostOf(word);
  const host = REMOTE_PATH_RE.exec(word.value)?.[1];
  return host === undefined ? null : host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** `scp` and `rsync` send to their last operand; `sftp` names only the remote end. */
function remoteCopy(cmd: SimpleCommand): ClassifiedAction[] {
  if (cmd.name === "sftp") {
    const [target] = readOptions(cmd.args, SCP_VALUES).positionals;
    return target ? actionsFor("bash.egress.remote-copy", [sftpHost(target)]) : [];
  }
  if (cmd.name !== "scp" && cmd.name !== "rsync") return [];
  const operands = readOptions(cmd.args, cmd.name === "scp" ? SCP_VALUES : RSYNC_VALUES).positionals;
  const dest = operands.length >= 2 ? operands.at(-1) : undefined;
  const host = dest && remoteHost(dest);
  return host ? actionsFor("bash.egress.remote-copy", [host]) : [];
}

function sftpHost(target: WordToken): string {
  return remoteHost(target) ?? target.value.replace(/^[^@]*@/, "").toLowerCase();
}

const AWS_VALUES = set("--profile", "--region", "--endpoint-url", "--output", "--query", "--ca-bundle", "--acl", "--storage-class", "--exclude", "--include", "--sse", "--sse-kms-key-id", "--content-type", "--cache-control", "--metadata-directive", "--expires", "--grants", "--page-size");
const GSUTIL_VALUES = set("-o", "-h", "-i", "-u", "-a", "-j", "-L", "-s", "-z", "-x");
const CLOUD_VERBS = set("cp", "sync", "mv", "rsync");

/** `aws s3 cp|sync|mv` or `gsutil cp|rsync|mv` whose destination is a bucket; the bucket is the host. */
function cloudCopy(cmd: SimpleCommand): ClassifiedAction[] {
  const bucket = (w: WordToken | undefined, scheme: string) => (w?.value.startsWith(scheme) ? [bucketOf(w, scheme)] : []);
  if (cmd.name === "aws") {
    const [service, verb, , ...rest] = readOptions(cmd.args, AWS_VALUES).positionals;
    if (service?.value !== "s3" || !verb || !CLOUD_VERBS.has(verb.value)) return [];
    return actionsFor("bash.egress.cloud-copy", rest.flatMap((w) => bucket(w, "s3://")));
  }
  if (cmd.name !== "gsutil") return [];
  const [verb, ...operands] = readOptions(cmd.args, GSUTIL_VALUES).positionals;
  if (!verb || !CLOUD_VERBS.has(verb.value) || operands.length < 2) return [];
  return actionsFor("bash.egress.cloud-copy", bucket(operands.at(-1), "gs://"));
}

function bucketOf(word: WordToken, scheme: string): string {
  return word.dynamic ? UNKNOWN : (word.value.slice(scheme.length).split("/")[0] ?? UNKNOWN);
}

const GIT_URL_RE = /^(?:[a-z][\w+.-]*:\/\/|[^@/:]+@[^/:]+:)/i;

/** `git push <url>` to a literal URL off the allowlist; a named remote cannot be resolved here. */
function pushUrl(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const git = parseGit(cmd.args, cmd.dir, ctx.home);
  if (git.subDynamic) return actionsFor("bash.egress.git-push-url", [UNKNOWN]);
  if (git.sub !== "push") return [];
  const [remote] = readOptions(git.subArgs, set("--repo", "-o", "--push-option", "--receive-pack", "--exec")).positionals;
  if (remote?.dynamic) return actionsFor("bash.egress.git-push-url", [UNKNOWN]);
  if (!remote || !GIT_URL_RE.test(remote.value)) return [];
  const host = remoteHost(remote) ?? hostOf(remote);
  return actionsFor("bash.egress.git-push-url", [host]);
}

function bash(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  if (cmd.name === "gh") return gist(cmd);
  if (cmd.name === "git") return pushUrl(cmd, ctx);
  return [...upload(cmd), ...socket(cmd), ...remoteCopy(cmd), ...cloudCopy(cmd)];
}

/** Named commands that send data off the machine: the EXT rows of the authority table. */
export const egress: Family = {
  names: set("gh", "git", "curl", "wget", "http", "https", "nc", "ncat", "netcat", "socat", "telnet", "scp", "sftp", "rsync", "aws", "gsutil"),
  bash,
};
