import type { WordToken } from "../shell/lexer.js";
import { hostOf } from "./egress.js";

const GRAPHQL_PATH_RE = /^\/graphql\/?$/i;

/** A literal URL word naming GitHub's GraphQL endpoint; a run-time URL is left to the dynamic-URL rule. */
export function isGitHubGraphql(word: WordToken): boolean {
  if (word.dynamic || hostOf(word) !== "api.github.com") return false;
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(word.value) ? word.value : `https://${word.value}`;
  try {
    return GRAPHQL_PATH_RE.test(decodePath(new URL(withScheme).pathname));
  } catch {
    return false;
  }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Texts a request body could hand GitHub as GraphQL, or null when the body is unknowable.
 * curl joins repeated `-d` values with `&` and concatenates `--json` values, so both joins are read raw and decoded.
 */
export function graphqlQueries(bodies: string[] | null): string[] | null {
  if (bodies === null) return null;
  const joins = [...new Set([bodies.join("&"), bodies.join("")])];
  return [...new Set([...joins, ...joins.flatMap(decodedQueries)])];
}

/** Every `query` string of a JSON body: one request object, or each element of a batch array. */
function decodedQueries(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const requests: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return requests.flatMap((r) => {
    const query = r !== null && typeof r === "object" ? (r as { query?: unknown }).query : undefined;
    return typeof query === "string" ? [query] : [];
  });
}
