import type { SimpleCommand } from "../shell/commands.js";
import { parseGit } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { hasFlag, lastValue, readOptions, set, valuesOf } from "./options.js";
import type { Options } from "./options.js";

/** Hosts data may be sent to (D5). `registry.npmjs.org` is allowed for reads only, so it is absent. */
const ALLOWED_HOSTS = set("github.com", "api.github.com", "localhost", "127.0.0.1", "::1");
/** A host only known at run time; never allowed. */
const UNKNOWN = "unknown";
/** A method known only at run time; it counts as a write. */
const UNKNOWN_METHOD = "UNKNOWN";
const UPLOAD_METHODS = set("POST", "PUT", "PATCH", UNKNOWN_METHOD);

const CURL_BODY = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"];
const CURL_VALUES = set(...CURL_BODY, "-X", "--request", "-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "--retry", "-K", "--config", "--cacert", "--cert", "-E", "--key", "-r", "--range", "-C", "--continue-at", "-D", "--dump-header", "--resolve", "--connect-to", "--url", "--oauth2-bearer", "--unix-socket", "--output-dir", "--variable", "--expand-url");
/** Words that start curl's next request, which takes its own method and URLs. */
const CURL_NEXT = set("--next", "-:");
const WGET_BODY = ["--post-data", "--post-file", "--body-data", "--body-file"];
const WGET_VALUES = set(...WGET_BODY, "--method", "-O", "--output-document", "-o", "--output-file", "-a", "-e", "-U", "--user-agent", "-t", "-T", "-w", "-P", "-i", "--input-file", "--header");
const HTTPIE_VALUES = set("-a", "--auth", "-A", "--auth-type", "-o", "--output", "--session", "--session-read-only", "-p", "--print", "-s", "--style", "--pretty", "--verify", "--cert", "--cert-key", "--timeout", "--proxy", "--raw", "--format-options", "--default-scheme");
/** An httpie request item; the earliest separator decides its kind. */
const HTTPIE_ITEM_RE = /==|:=@|:=|=@|=|@|:/;
const HTTPIE_METHODS = set("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");

/**
 * A URL the request goes to that the command line does not show: read from a file or appended by xargs.
 * Its `$` marks a run-time part the way the lexer leaves an unexpanded variable in `value`.
 */
const UNSEEN_URL: WordToken = { type: "word", value: "$", dynamic: true, quoted: false, spliced: false, computed: true, refs: [], subs: [] };

export interface HttpRequest {
  method: string;
  body: boolean;
  urls: WordToken[];
}

/**
 * The request `curl`, `wget`, `http` or `https` would send, or null for any other command. What the
 * command line does not show fails closed: a run-time method is a write and an unseen URL is run-time.
 */
export function httpRequest(cmd: SimpleCommand): HttpRequest | null {
  const request = clientRequest(cmd);
  if (!request) return null;
  const unseen = request.urls.length === 0 || cmd.wrapping.includes("xargs");
  return unseen ? { ...request, urls: [...request.urls, UNSEEN_URL] } : request;
}

function clientRequest(cmd: SimpleCommand): HttpRequest | null {
  if (cmd.name === "curl") return curlRequest(cmd.args);
  if (cmd.name === "wget") return wgetRequest(readOptions(cmd.args, WGET_VALUES));
  if (cmd.name === "http" || cmd.name === "https") return httpieRequest(readOptions(cmd.args, HTTPIE_VALUES));
  return null;
}

export const isWrite = (method: string) => method !== "GET" && method !== "HEAD";

const methodOf = (word: WordToken | null) => (word === null ? null : word.dynamic ? UNKNOWN_METHOD : word.value.toUpperCase());

/** Each `--next` request reads alone; together they send the first write method to every URL. */
function curlRequest(args: WordToken[]): HttpRequest {
  const parts: WordToken[][] = [[]];
  for (const word of args) {
    if (CURL_NEXT.has(word.value)) parts.push([]);
    else parts.at(-1)?.push(word);
  }
  const requests = parts.map((part) => curlPart(readOptions(part, CURL_VALUES)));
  const method = (requests.find((r) => isWrite(r.method)) ?? (requests[0] as HttpRequest)).method;
  return { method, body: requests.some((r) => r.body), urls: requests.flatMap((r) => r.urls) };
}

function curlPart(o: Options): HttpRequest {
  const body = hasFlag(o, ...CURL_BODY);
  const upload = hasFlag(o, "-T", "--upload-file");
  const implied = hasFlag(o, "-G", "--get") ? "GET" : upload ? "PUT" : body ? "POST" : "GET";
  const method = methodOf(lastValue(o, "-X", "--request")) ?? implied;
  const globs = !hasFlag(o, "-g", "--globoff");
  const urls = [...o.positionals, ...valuesOf(o, "--url")].map((u) => (globs ? globbed(u) : u));
  const expanded = valuesOf(o, "--expand-url").map((u) => runTimeFrom(u, u.value.indexOf("{{")));
  return { method, body, urls: [...urls, ...expanded] };
}

/** curl expands `{a,b}` and `[1-3]` in a URL unless `-g` is given; an IPv6 host's brackets are not a glob. */
function globbed(word: WordToken): WordToken {
  const host = /^[a-z][\w+.-]*:\/\/\[[0-9a-f:.]*\]/i.exec(word.value)?.[0].length ?? 0;
  const at = word.value.slice(host).search(/[{[]/);
  return at < 0 ? word : runTimeFrom(word, host + at);
}

/** The word with everything from `at` on known only at run time. */
function runTimeFrom(word: WordToken, at: number): WordToken {
  return at < 0 ? word : { ...word, value: `${word.value.slice(0, at)}$`, dynamic: true };
}

function wgetRequest(o: Options): HttpRequest {
  const body = hasFlag(o, ...WGET_BODY);
  const method = methodOf(lastValue(o, "--method")) ?? (body ? "POST" : "GET");
  const listed = hasFlag(o, "-i", "--input-file") ? [UNSEEN_URL] : [];
  return { method, body, urls: [...o.positionals, ...listed] };
}

/** `http [METHOD] URL [ITEM...]`; `key=value`, `key:=json` and `key@file` items make a body, headers and `==` queries do not. */
function httpieRequest(o: Options): HttpRequest {
  const [first, ...rest] = o.positionals;
  const explicit = first && isHttpieMethod(first, rest[0]) ? methodOf(first) : null;
  const [url, ...items] = explicit ? rest : o.positionals;
  const body = hasFlag(o, "--raw") || items.some((i) => isBodyItem(i.value));
  return { method: explicit ?? (body ? "POST" : "GET"), body, urls: url ? [url] : [] };
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
