import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { reviewCheckoutRoot } from "./review-checkout.js";

export const REVIEW_CHECKOUT_MAX_AGE_MS = 24 * 3_600_000;
/** The name a reviewer extracts into: `review-<pr>-<first 12 hex of the head sha>`. */
export const REVIEW_CHECKOUT_NAME = /^review-[1-9][0-9]*-[0-9a-f]{12}$/;

export interface ReviewCheckoutSweepDeps {
  /** Defaults to the app data dir's review checkouts; a backstop for runs that never reached removal. */
  root?: string;
  now?: () => number;
  list?: (root: string) => Promise<string[]>;
  /** Must not follow symlinks; only real directories are swept. */
  stat?: (path: string) => Promise<{ isDirectory: boolean; mtimeMs: number }>;
  remove?: (path: string) => Promise<void>;
  /** Called once per entry that failed; the sweep carries on with the rest. */
  onError?: (path: string, error: unknown) => void;
}

/** A run dir holds the head and base checkouts, both plain `git archive` trees, so `rm -rf` is the whole removal. Returns the paths removed. */
export async function sweepReviewCheckouts(deps: ReviewCheckoutSweepDeps = {}): Promise<string[]> {
  const root = deps.root ?? reviewCheckoutRoot();
  const now = (deps.now ?? Date.now)();
  const list = deps.list ?? ((dir: string) => readdir(dir));
  const stat =
    deps.stat ??
    (async (path: string) => {
      const info = await lstat(path);
      return { isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs };
    });
  const remove = deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const removed: string[] = [];
  for (const name of await list(root)) {
    if (!REVIEW_CHECKOUT_NAME.test(name)) continue;
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory || now - info.mtimeMs <= REVIEW_CHECKOUT_MAX_AGE_MS) continue;
      await remove(path);
      removed.push(path);
    } catch (error) {
      deps.onError?.(path, error);
    }
  }
  return removed;
}
