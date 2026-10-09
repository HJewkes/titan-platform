import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appDirs, type PathOptions } from "@titan-design/app-paths";
import { reviewCheckoutName } from "@titan-design/review-panel";

/** Review checkouts are live state while a reviewer reads them, so they sit in the data dir, never in `$TMPDIR` or a cache. */
export function reviewCheckoutRoot(opts: PathOptions = {}): string {
  return join(appDirs("titan-factory", opts).data, "checkouts", "reviews");
}

/** The one directory a run's head and base checkouts both live under. */
export function reviewCheckoutDir(root: string, target: { pr: number; head: string }): string {
  return join(root, reviewCheckoutName(target.pr, target.head));
}

export type RemoveDir = (path: string) => Promise<void>;

const removeTree: RemoveDir = (path) => rm(path, { recursive: true, force: true });

/** Removes the run's whole checkout dir; a failure to remove is returned, not thrown, so it cannot change a verdict. Returns the error, if any. */
export async function removeReviewCheckout(root: string, target: { pr: number; head: string }, remove: RemoveDir = removeTree): Promise<unknown> {
  try {
    await remove(reviewCheckoutDir(root, target));
    return undefined;
  } catch (error) {
    return error;
  }
}
