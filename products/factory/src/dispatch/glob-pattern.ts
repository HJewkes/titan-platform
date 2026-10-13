/**
 * The owns-glob dialect burndown matches files and claims with: `*` within one segment, `**` across segments, a
 * trailing `/` as a directory prefix, anything else literal. Ported from agent-chat's `isolation/file-ownership.ts`
 * (`matchPattern`) and `broker/claims.ts` (`patternsOverlap`).
 */

export function matchPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return filePath.startsWith(pattern) || filePath === pattern.slice(0, -1);
  if (!pattern.includes("*")) return filePath === pattern;
  return new RegExp(`^${globToRegex(pattern)}$`).test(filePath);
}

/** Token by token so that `**` can span separators while `*` cannot; a trailing `src/**` matches the whole subtree. */
function globToRegex(pattern: string): string {
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") i++;
      regexStr += i >= pattern.length ? ".*" : "(?:.+/)?";
    } else if (char === "*") {
      regexStr += "[^/]*";
      i++;
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return regexStr;
}

/**
 * Whether two patterns describe any of the same files, decided from the patterns alone: both sides are regular
 * languages, so the walk is segment by segment. A missed overlap silently loses an edit and a false one costs a
 * conversation, so the one shape this does not decide (`**` inside a longer segment) counts as an overlap.
 */
export function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (!hasWildcard(a) && !hasWildcard(b)) return matchPattern(a, b) || matchPattern(b, a);
  const [globA, globB] = [asGlob(a), asGlob(b)];
  if (isFilePath(a)) return matchPattern(a, globB);
  if (isFilePath(b)) return matchPattern(b, globA);
  return globsIntersect(globA, globB);
}

const hasWildcard = (pattern: string): boolean => pattern.includes("*");

const isFilePath = (pattern: string): boolean => !hasWildcard(pattern) && !pattern.endsWith("/");

/** A trailing-slash pattern is a directory prefix, which is what `dir/**` says. */
const asGlob = (pattern: string): string => (pattern.endsWith("/") ? `${pattern}**` : pattern);

const ANY_SEGMENTS = "**";

/**
 * A trailing `**` needs at least one segment and an interior one accepts none, so the trailing form is rewritten as
 * one `*` segment followed by the interior form. Every `**` the walk sees then means "zero or more segments".
 */
function segmentsOf(glob: string): string[] {
  const segments = glob.split("/");
  return segments.at(-1) === ANY_SEGMENTS ? [...segments.slice(0, -1), "*", ANY_SEGMENTS] : segments;
}

function globsIntersect(a: string, b: string): boolean {
  const [left, right] = [segmentsOf(a), segmentsOf(b)];
  const undecided = (s: string): boolean => s.includes(ANY_SEGMENTS) && s !== ANY_SEGMENTS;
  if (left.some(undecided) || right.some(undecided)) return true;
  return walkSegments(left, right);
}

/** Can `left[i..]` and `right[j..]` match one common path? Memoised over (i, j). */
function walkSegments(left: string[], right: string[]): boolean {
  const memo = new Map<number, boolean>();
  const from = (i: number, j: number): boolean => {
    const key = i * (right.length + 1) + j;
    let result = memo.get(key);
    if (result === undefined) {
      result = step(i, j);
      memo.set(key, result);
    }
    return result;
  };
  const step = (i: number, j: number): boolean => {
    if (left[i] === ANY_SEGMENTS) return from(i + 1, j) || (j < right.length && from(i, j + 1));
    if (right[j] === ANY_SEGMENTS) return from(i, j + 1) || (i < left.length && from(i + 1, j));
    if (i === left.length || j === right.length) return i === left.length && j === right.length;
    return segmentsIntersect(left[i] as string, right[j] as string) && from(i + 1, j + 1);
  };
  return from(0, 0);
}

function segmentsIntersect(a: string, b: string): boolean {
  if (!hasWildcard(a)) return matchPattern(a, b);
  if (!hasWildcard(b)) return matchPattern(b, a);
  return starSegmentsIntersect(a, b);
}

/** Two `*` segments share a name exactly when their fixed heads agree and their fixed tails agree. */
function starSegmentsIntersect(a: string, b: string): boolean {
  const head = (s: string): string => s.slice(0, s.indexOf("*"));
  const tail = (s: string): string => s.slice(s.lastIndexOf("*") + 1);
  const [headA, headB, tailA, tailB] = [head(a), head(b), tail(a), tail(b)];
  return (headA.startsWith(headB) || headB.startsWith(headA)) && (tailA.endsWith(tailB) || tailB.endsWith(tailA));
}
