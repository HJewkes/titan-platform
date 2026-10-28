import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { statusOf } from "../required-checks.js";

/** A CI-policy plan approval pins at most this many files, so a PR changing more could never be covered whole. */
const MAX_HEAD_BLOBS = 20;

const UNREAD_PREFIX = "the head blobs of the changed files are unread: ";

export type HeadBlobsRead = { headBlobs: Record<string, string | null> } | { unread: string };

/**
 * Each changed path's git blob sha at `head`, null where the file is absent there (a deletion or rename source). Any
 * failed read, or more paths than an approval can pin, reads nothing, so no plan approval can cover the head.
 */
export async function readHeadBlobs(port: GitHubPort, { repo, head }: { repo: RepoSlug; head: string }, paths: readonly string[]): Promise<HeadBlobsRead> {
  const unique = [...new Set(paths)];
  if (unique.length > MAX_HEAD_BLOBS) return { unread: `${UNREAD_PREFIX}${unique.length} changed files, more than the ${MAX_HEAD_BLOBS} a plan approval pins` };
  try {
    const blobs = await Promise.all(unique.map(async (path) => [path, (await port.getFile(repo, path, head))?.blobSha ?? null] as const));
    return { headBlobs: Object.fromEntries(blobs) };
  } catch (error) {
    return { unread: `${UNREAD_PREFIX}${statusOf(error)}` };
  }
}
