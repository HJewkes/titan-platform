/** The tag a scoped re-review's new item outside the fix ranges must start with to be allowed (TP-3735). */
export const IMPORTANT_TAG = "Important:";
/** The line that names such an item's class. */
export const CLASS_TAG = "Class:";
/** More paths than this is no longer a fix round's diff, so the review goes full. */
export const MAX_SCOPE_PATHS = 40;

/** Changed lines at the head, `start` to `end` inclusive; `end` below `start` is a pure deletion after line `start`. */
export interface ScopeHunk {
  path: string;
  start: number;
  end: number;
}

/** A fix round's own change: the head reviewed last, and what changed since it with main's merged changes left out. */
export interface ReviewScope {
  sinceHead: string;
  paths: readonly string[];
  hunks: readonly ScopeHunk[];
  /** True when main was merged in since `sinceHead`, so `git diff sinceHead head` also shows main's edits. */
  mergedBase: boolean;
}

/** The path is interpolated inside double quotes in shell lines, so anything a shell expands or ends a quote with is refused. */
const SHELL_ACTIVE = /["$`\\]/;
const hasControlChar = (text: string): boolean => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
export const shellSafe = (text: string): boolean => !SHELL_ACTIVE.test(text) && !hasControlChar(text);

const FULL_SHA = /^[0-9a-f]{40}$/;
const usablePath = (path: string): boolean => path !== "" && shellSafe(path);
const usableHunk = (paths: readonly string[], hunk: ScopeHunk): boolean =>
  paths.includes(hunk.path) && Number.isInteger(hunk.start) && Number.isInteger(hunk.end) && hunk.start >= 0;

/** Any doubt means a full review: a scope that fails here, or has no open finding to check, leaves the brief unscoped. */
export function usableScope(scope: ReviewScope | undefined, openFindings: number): scope is ReviewScope {
  if (scope === undefined || openFindings < 1 || !FULL_SHA.test(scope.sinceHead)) return false;
  const { paths, hunks } = scope;
  return paths.length > 0 && paths.length <= MAX_SCOPE_PATHS && paths.every(usablePath) && hunks.every((hunk) => usableHunk(paths, hunk));
}

/** Replaces `gh pr diff`: the reviewer reads the fix diff, not the whole PR's. */
export function scopedDiffLine(git: string, head: string, scope: ReviewScope): string {
  const paths = scope.paths.map((path) => `"${path}"`).join(" ");
  return `  ${git} fetch origin ${scope.sinceHead} && ${git} diff ${scope.sinceHead} ${head} -- ${paths}`;
}

const rangeText = ({ start, end }: ScopeHunk): string => (end < start ? `after ${start} (deleted)` : start === end ? `${start}` : `${start}-${end}`);

function rangeLines(scope: ReviewScope): string[] {
  return scope.paths.map((path) => {
    const ranges = scope.hunks.filter((hunk) => hunk.path === path).map(rangeText);
    return `- ${path}: ${ranges.length === 0 ? "whole file" : ranges.join(", ")}`;
  });
}

const mergedBaseLines = (scope: ReviewScope): string[] =>
  scope.mergedBase
    ? [`Main was merged into this PR since head ${scope.sinceHead.slice(0, 12)}, so that diff also shows main's changes in these paths. Only the ranges below are the fix; take main's changes as given.`]
    : [];

/** The fix diff is the review's subject; the unchanged-line and no-repeat rules keep a fix round from re-reviewing the whole PR. */
export function scopeLines(scope: ReviewScope): string[] {
  return [
    `This is a fix-round re-review. The fix is the change from head ${scope.sinceHead.slice(0, 12)} to this head that the diff command above shows. Judge that fix diff, and whether it fixes each earlier finding; read the rest of the head only for context.`,
    ...mergedBaseLines(scope),
    "The fix's changed line ranges at this head:",
    ...rangeLines(scope),
    "For every function whose behaviour the fix changes, read its callers at this head, even when the callers are unchanged.",
    `A new blocking item on a line outside those ranges is allowed only when it starts with \`${IMPORTANT_TAG}\` and has a line \`${CLASS_TAG} <class>\` naming its class; leave out any other finding outside them.`,
    "Never restate an earlier finding as a new blocking item: one that is still open goes in the earlier findings checklist as not fixed or partly fixed.",
  ];
}
