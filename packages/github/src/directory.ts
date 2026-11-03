import type { RepoEntry } from "./port-types.js";
import type { Rest } from "./rest.js";

/** GitHub's contents API lists at most this many entries of one directory and says nothing when it stops there. */
export const DIRECTORY_LIST_CAP = 1000;

interface ContentsEntry {
  type: string;
  path: string;
  sha: string;
}

/**
 * The files directly under `path` at `ref`, subdirectories left out; null when nothing is at `path`. A path that is a
 * file, or a listing at the cap, throws: a caller that reads the list as complete must never get a short one.
 */
export async function listDirectory(api: Rest, repo: string, path: string, ref: string): Promise<RepoEntry[] | null> {
  const listing = await api.getOrNull<ContentsEntry | ContentsEntry[]>(`repos/${repo}/contents/${path}`, { ref });
  if (listing === null) return null;
  if (!Array.isArray(listing)) throw new Error(`${path} at ${ref} is not a directory`);
  if (listing.length >= DIRECTORY_LIST_CAP) throw new Error(`${path} at ${ref} lists ${listing.length} entries, at GitHub's cap of ${DIRECTORY_LIST_CAP}`);
  return listing.filter((entry) => entry.type === "file").map((entry) => ({ path: entry.path, blobSha: entry.sha }));
}
