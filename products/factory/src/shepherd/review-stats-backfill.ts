import { join } from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { ownDiffExclusions } from "./own-diff.js";
import { isRepoKey } from "./seats.js";
import { DIFF_ARGS, cacheFor, patchIdOf, remoteBase, type CarryOptions } from "./tree-carry.js";

/** The base a round's own diff is read against when its run recorded none; a stacked PR's older heads read against main too. */
const BASE_REF = "main";

/** A head's own-diff id read from the cache as it stands, or null when the cache cannot answer. Never fetches, never writes. */
export type OwnDiffReader = (repo: string, head: string) => Promise<string | null>;

/** Heads already in the cache are read; a head the cache lacks stays without an id, never guessed from a fetch or another head. */
export function cacheOwnDiffReader(options: CarryOptions): OwnDiffReader {
  return async (repo, head) => {
    if (!isRepoKey(repo)) return null;
    const { git, fs, dir } = cacheFor(repo, options);
    if (!fs.exists(join(dir, "HEAD"))) return null;
    const has = await git(dir, ["cat-file", "-e", `${head}^{commit}`], options.signal);
    const base = await git(dir, ["merge-base", head, remoteBase(BASE_REF)], options.signal);
    if (has.code !== 0 || base.code !== 0) return null;
    const diff = await git(dir, [...DIFF_ARGS, base.stdout.trim(), head, "--", ".", ...ownDiffExclusions(repo)], options.signal);
    return diff.code === 0 ? patchIdOf(diff.stdout) : null;
  };
}

export interface BackfillCounts {
  computed: number;
  missing: number;
}

/** Ids read from the cache, per run and head, with how many heads got one and how many the cache could not answer for. */
export interface Backfill extends BackfillCounts {
  ids: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export const NO_BACKFILL: Backfill = { ids: new Map(), computed: 0, missing: 0 };

/** A head the run recorded no own-diff id for, which the cache may still answer. */
export interface WantedHead {
  run: WorkflowRun;
  head: string;
}

/** Each wanted head is read once however many runs share it; a repeat of a missing head counts once. */
export async function backfillOwnDiffs(wanted: readonly WantedHead[], read: OwnDiffReader): Promise<Backfill> {
  const ids = new Map<string, Map<string, string>>();
  const answers = new Map<string, string | null>();
  for (const { run, head } of wanted) {
    const repo = (run.params.repo ?? "").toLowerCase();
    const key = `${repo}@${head}`;
    if (!answers.has(key)) answers.set(key, await read(repo, head));
    const id = answers.get(key);
    if (id !== null && id !== undefined) ids.set(run.id, (ids.get(run.id) ?? new Map()).set(head, id));
  }
  const found = [...answers.values()].filter((id) => id !== null).length;
  return { ids, computed: found, missing: answers.size - found };
}
