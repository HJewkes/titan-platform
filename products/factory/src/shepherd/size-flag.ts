import type { GitHubPort, PrFile } from "@titan-design/github";
import { securitySliceFlag, type SliceFlag } from "@titan-design/review-panel";
import { localPrFiles, prFilesOf, type PrFilesRead } from "./git-pr-files.js";
import type { Registration } from "./store.js";

export type { SliceFlag };

/** Registration waits this long at most for the file list; the flag is advisory, so a slow read just goes unflagged. */
const SIZE_FLAG_TIMEOUT_MS = 15_000;

interface SizeFlagOptions {
  local?: PrFilesRead;
  timeoutMs?: number;
}

/** A file with no counts stays NaN, so the panel reads the whole count as unread rather than as 0 lines. */
const changedFilesOf = (files: readonly PrFile[]) =>
  files.map(({ path, previousPath, additions, deletions }) => ({ path, ...(previousPath !== undefined && { previousPath }), additions: additions ?? Number.NaN, deletions: deletions ?? Number.NaN }));

function withinMs<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms).unref()));
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * The TP-2395 slice cap: a security-kind or guard-area PR over about 400 non-generated lines rarely converges in three
 * review rounds. Advisory only, so any read error or timeout gives no flag and never fails the registration.
 */
export async function sizeFlagFor(port: GitHubPort, registration: Registration, options: SizeFlagOptions = {}): Promise<SliceFlag | undefined> {
  const { repo, pr, kind, headSha, base } = registration;
  if (pr === null) return undefined;
  const target = { repo, pr, ...(headSha !== null && { head: headSha }), ...(base !== null && { base }) };
  try {
    const files = await withinMs(prFilesOf(port, target, options.local ?? localPrFiles), options.timeoutMs ?? SIZE_FLAG_TIMEOUT_MS);
    return files === undefined ? undefined : securitySliceFlag({ kind, changedFiles: changedFilesOf(files) });
  } catch {
    return undefined;
  }
}
