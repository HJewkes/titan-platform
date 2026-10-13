import type { WordToken } from "../shell/lexer.js";
import { set } from "./options.js";

/** Hosts that serve GitHub's REST merge endpoints. */
const GITHUB_API_HOSTS = set("api.github.com");
const SCHEME_RE = /^[a-z][\w+.-]*:\/\//i;
/** The authority is complete only once a path, query or fragment delimiter follows it. */
const AUTHORITY_RE = /^[a-z][\w+.-]*:\/\/([^/?#]*)[/?#]/i;
const PLAIN_HOST_RE = /^[a-z0-9.-]+$/;
const IPV6_HOST_RE = /^\[[0-9a-f:.]+\]$/;

/**
 * Whether a URL word may name a GitHub API endpoint that the literal matchers cannot see: its host is
 * known only at run time, or it is `api.github.com` with a run-time path or query. A literal word is
 * left to the literal endpoint matchers.
 */
export function mayReachGitHubApi(word: WordToken): boolean {
  if (!word.dynamic) return false;
  const host = literalHost(word.value.slice(0, firstExpansion(word)));
  return host === null || GITHUB_API_HOSTS.has(host);
}

/**
 * Where the first run-time part of a dynamic word lands in its `value`. Command substitutions are cut
 * out of `value`, so their `cuts` mark them; a dynamic word with no marked part is unknown from the start.
 */
function firstExpansion(word: WordToken): number {
  const marked = word.value.search(/[$`]/);
  const starts = [...word.refs.map((r) => r.start), ...(word.cuts ?? []).map((c) => c.at), ...(marked >= 0 ? [marked] : [])];
  return starts.length > 0 ? Math.min(...starts) : 0;
}

/** The normalized host a literal URL prefix names, or null when the host is incomplete or not a plain name or IP. */
function literalHost(prefix: string): string | null {
  const url = SCHEME_RE.test(prefix) ? prefix : `http://${prefix.replace(/^:/, "localhost:")}`;
  const authority = AUTHORITY_RE.exec(url)?.[1];
  // WHATWG URL folds \ into /, but curl and wget need not, so a backslash leaves the host unknown.
  if (authority === undefined || authority.includes("\\")) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  return PLAIN_HOST_RE.test(hostname) || IPV6_HOST_RE.test(hostname) ? hostname : null;
}
