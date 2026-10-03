import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REVIEW_CHECKOUT_MAX_AGE_MS = 24 * 3_600_000;
const PREFIX = "review-";

export interface ReviewCheckoutSweepDeps {
  /** Defaults to the system temp dir, where reviewers extract their checkouts. */
  root?: string;
  now?: () => number;
  list?: (root: string) => string[];
  /** Must not follow symlinks; only real directories are swept. */
  stat?: (path: string) => { isDirectory: boolean; mtimeMs: number };
  remove?: (path: string) => void;
  /** Called once per entry that failed; the sweep carries on with the rest. */
  onError?: (path: string, error: unknown) => void;
}

/** Reviewers extract with `git archive`, so a checkout is a plain directory and `rm` is the whole removal. Returns the paths removed. */
export function sweepReviewCheckouts(deps: ReviewCheckoutSweepDeps = {}): string[] {
  const root = deps.root ?? tmpdir();
  const now = (deps.now ?? Date.now)();
  const list = deps.list ?? ((dir: string) => readdirSync(dir));
  const stat =
    deps.stat ??
    ((path: string) => {
      const info = lstatSync(path);
      return { isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs };
    });
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const removed: string[] = [];
  for (const name of list(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(root, name);
    try {
      const info = stat(path);
      if (!info.isDirectory || now - info.mtimeMs <= REVIEW_CHECKOUT_MAX_AGE_MS) continue;
      remove(path);
      removed.push(path);
    } catch (error) {
      deps.onError?.(path, error);
    }
  }
  return removed;
}
