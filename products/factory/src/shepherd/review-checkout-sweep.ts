import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REVIEW_CHECKOUT_MAX_AGE_MS = 24 * 3_600_000;
const PREFIX = "review-";

export interface ReviewCheckoutSweepDeps {
  /** Defaults to the system temp dir, where reviewers extract their checkouts. */
  root?: string;
  now?: () => number;
  list?: (root: string) => string[];
  mtimeMs?: (path: string) => number;
  remove?: (path: string) => void;
}

/** Reviewers extract with `git archive`, so a checkout is a plain directory and `rm` is the whole removal. Returns the paths removed. */
export function sweepReviewCheckouts(deps: ReviewCheckoutSweepDeps = {}): string[] {
  const root = deps.root ?? tmpdir();
  const now = (deps.now ?? Date.now)();
  const list = deps.list ?? ((dir: string) => readdirSync(dir));
  const mtimeMs = deps.mtimeMs ?? ((path: string) => statSync(path).mtimeMs);
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const removed: string[] = [];
  for (const name of list(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(root, name);
    if (now - mtimeMs(path) <= REVIEW_CHECKOUT_MAX_AGE_MS) continue;
    remove(path);
    removed.push(path);
  }
  return removed;
}
