import type { WordToken } from "../shell/lexer.js";
import { hostOf } from "./egress.js";
import { set } from "./options.js";

/** Hosts that serve GitHub's REST merge endpoints. */
const GITHUB_API_HOSTS = set("api.github.com");

/**
 * Whether a URL word may name a GitHub API endpoint that the literal matchers cannot see: its host is
 * known only at run time, or it is `api.github.com` with a run-time path or query. A literal word is
 * left to the literal endpoint matchers.
 */
export function mayReachGitHubApi(word: WordToken): boolean {
  if (!word.dynamic) return false;
  const host = hostOf(word);
  return host === "unknown" || GITHUB_API_HOSTS.has(host);
}
