/**
 * Dot segments in a URL path, as the client resolves them before sending. Default curl (8.18 verified) resolves
 * `.` and `..` by RFC 3986 section 5.2.4 and counts `%2e` as a dot while it does; gh, wget and httpie differ.
 */
import { asciiDecoded } from "./api-branch-refs.js";

/** curl 8.18 takes one to three slashes after the scheme as the authority's lead-in and rejects four or more. */
const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/{1,3}[^/?#]*/i;
const CURL_REJECTED_RE = /^[a-z][a-z0-9+.-]*:\/{4}/i;

const dotted = (segment: string) => segment.replace(/%2e/gi, ".");
const isDotSegment = (segment: string) => dotted(segment) === "." || dotted(segment) === "..";

const pathPart = (text: string) => text.replace(/[?#].*$/s, "");

/**
 * Whether the path before any query or fragment has a `.` or `..` segment, as written, with `%2e` spellings, or
 * once ASCII escapes decode. The decoded reading fails closed on a server that decodes `%2F` before it resolves.
 */
export function hasDotSegment(path: string): boolean {
  const raw = pathPart(path);
  return [raw, asciiDecoded(raw)].some((p) => p.split("/").some(isDotSegment));
}

/** Resolves a `/`-led path: `.` drops, `..` pops even an empty segment but never above root. */
function resolved(path: string): string {
  const segments = path.slice(1).split("/");
  const kept: string[] = [];
  for (const [i, segment] of segments.entries()) {
    if (!isDotSegment(segment)) kept.push(segment);
    else if (dotted(segment) === "..") kept.pop();
    if (isDotSegment(segment) && i === segments.length - 1) kept.push("");
  }
  return `/${kept.join("/")}`;
}

/**
 * The URL with its path resolved as default curl sends it. The scheme and authority (or, with no scheme, the text
 * before the first `/`), the query and the fragment stay as written, as do kept segments. A URL curl rejects is
 * never sent, so it stays as written.
 */
export function curlSquashed(url: string): string {
  if (CURL_REJECTED_RE.test(url)) return url;
  const prefixEnd = SCHEME_PREFIX_RE.exec(url)?.[0].length ?? url.search(/[/?#]|$/);
  const rest = url.slice(prefixEnd);
  const path = pathPart(rest);
  if (!path.startsWith("/")) return url;
  return url.slice(0, prefixEnd) + resolved(path) + rest.slice(path.length);
}
