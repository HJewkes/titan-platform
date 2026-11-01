import { gitOrNull } from "./git.js";

/** Ignored paths `git worktree remove` would delete that a build or re-attach puts back. */
const REGENERABLE_DIRS = ["node_modules", "dist", "coverage", ".turbo"];

/** `.claude` only at the top, since re-attach copies it from the repository root. */
export const isRegenerable = (entry: string): boolean => {
  const segments = entry.split("/").filter(Boolean);
  return segments[0] === ".claude" || segments.some((segment) => REGENERABLE_DIRS.includes(segment));
};

/** Caller policy: extra ignored paths that count as disposable. `*` matches within a segment, `**` across segments; a pattern also covers everything beneath a match. */
export interface IgnoredFilesPolicy {
  readonly disposable: readonly string[];
}

function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/^\/+|\/+$/g, "")
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}(/.*)?$`);
}

const isDisposable = (entry: string, patterns: readonly RegExp[]): boolean => {
  const path = entry.replace(/\/+$/, "");
  return patterns.some((pattern) => pattern.test(path));
};

/** `--directory` collapses a wholly ignored directory to one entry; a caller pattern needs the files inside it. */
async function expandCollapsedDirs(worktree: string, entries: readonly string[]): Promise<string[] | null> {
  const expanded: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith("/")) { expanded.push(entry); continue; }
    const inside = await gitOrNull(["ls-files", "--others", "--ignored", "--exclude-standard", "--", entry], worktree);
    if (inside === null) return null;
    expanded.push(...inside.split("\n").filter((file) => file !== ""));
  }
  return expanded;
}

/**
 * Why removing this worktree would lose files, or undefined when it would not.
 *
 * `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file the removal would take.
 * A status git cannot read counts as dirty: a broken gitdir says nothing about what is on disk.
 */
export interface UnsavedObservation {
  detail: string;
  kind: "changes" | "other";
}

/** Internal typed observation; the string wrapper keeps existing callers unchanged. */
export async function observeUnsavedWork(worktree: string, policy?: IgnoredFilesPolicy): Promise<UnsavedObservation | undefined> {
  const status = await gitOrNull(["status", "--porcelain", "-uall"], worktree);
  if (status === null) return { detail: `could not read git status in ${worktree}`, kind: "other" };
  if (status !== "") return { detail: `uncommitted or untracked changes in ${worktree}`, kind: "changes" };
  const ignored = await gitOrNull(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], worktree);
  if (ignored === null) return { detail: `could not list ignored files in ${worktree}`, kind: "other" };
  const extra = (policy?.disposable ?? []).map(patternToRegExp);
  const candidates = ignored.split("\n").filter((entry) => entry !== "" && !isRegenerable(entry));
  const files = extra.length === 0 ? candidates : await expandCollapsedDirs(worktree, candidates);
  if (files === null) return { detail: `could not list ignored files in ${worktree}`, kind: "other" };
  const kept = files.filter((entry) => !isDisposable(entry, extra));
  if (kept.length === 0) return undefined;
  return {
    kind: "other",
    detail:
    `ignored files in ${worktree} would be deleted (${kept.slice(0, 3).join(", ")}); ` +
    `only ignored ${REGENERABLE_DIRS.join(", ")} and a top-level .claude are removed`,
  };
}

/** The existing diagnostic-only contract. */
export async function unsavedWork(worktree: string): Promise<string | undefined> {
  return (await observeUnsavedWork(worktree))?.detail;
}
