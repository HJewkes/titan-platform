import type { WordToken } from "../shell/lexer.js";
import { hostOf } from "./egress.js";

/** `/graphql` then anything that cannot extend the word, so `.json`, `;x`, `/` and a decoded space all count. */
const GRAPHQL_PATH_RE = /^\/graphql(?![\w-])/i;
const JSON_ESCAPE_RE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const SHORT_ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** A literal URL word naming GitHub's GraphQL endpoint; a run-time URL is left to the dynamic-URL rule. */
export function isGitHubGraphql(word: WordToken): boolean {
  if (word.dynamic || hostOf(word) !== "api.github.com") return false;
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(word.value) ? word.value : `https://${word.value}`;
  try {
    return GRAPHQL_PATH_RE.test(decodePath(new URL(withScheme).pathname).replace(/\/{2,}/g, "/"));
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
 * curl joins repeated `-d` values with `&` and concatenates `--json` values, so both joins are read raw, with JSON
 * escapes undone leniently, and decoded. A join that looks like JSON but that no strict parser takes is unknowable,
 * since GitHub's parser may be laxer.
 */
export function graphqlQueries(bodies: string[] | null): string[] | null {
  if (bodies === null) return null;
  const joins = [...new Set([bodies.join("&"), bodies.join("")])].map((j) => j.replace(/^\uFEFF/, ""));
  const decoded = joins.map(parsedJson);
  if (decoded.every((d) => d === undefined) && joins.some(looksLikeJson)) return null;
  const queries = decoded.flatMap((d) => (d === undefined ? [] : queriesOf(d)));
  return [...new Set([...joins, ...joins.map(unescapeJson), ...queries])];
}

function looksLikeJson(text: string): boolean {
  return /^\s*[[{]/.test(text);
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function unescapeJson(text: string): string {
  return text.replace(JSON_ESCAPE_RE, (_, hex: string | undefined, short: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : (SHORT_ESCAPES[short] ?? short));
}

/** Every `query` string of a decoded body: one request object, or each element of a batch array. */
function queriesOf(parsed: unknown): string[] {
  const requests: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return requests.flatMap((r) => {
    const query = r !== null && typeof r === "object" ? (r as { query?: unknown }).query : undefined;
    return typeof query === "string" ? [query] : [];
  });
}
