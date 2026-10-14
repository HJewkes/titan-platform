import type { WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { UpdateResultResult } from "../workflows/land-steps.js";
import type { Vouch } from "./hold-slot-rows.js";
import { isCleanMergeUpOf } from "./merge-up-carry.js";
import type { CarryInput, CarryResult } from "./tree-carry.js";

/** What a release across Shepherd's own merge-up reads; a host without them takes a release at the PR's current head only. */
export interface MergeUpReads {
  /** The heads Shepherd's own update-branch made on the run. */
  ownUpdates: () => ReadonlySet<string>;
  carry: (input: CarryInput) => Promise<CarryResult>;
}

/** Every head an `update-branch` step recorded as its own merge of the base, the record `onUpdated` reads too. */
export function ownUpdatedHeads(run: WorkflowRun): Set<string> {
  const heads = new Set<string>();
  for (const result of Object.values(run.stepResults)) {
    if (!stepIdMatches("update-branch", result.stepId)) continue;
    const update = UpdateResultResult.safeParse(result.data?.result);
    if (update.success && update.data.own) heads.add(update.data.headSha);
  }
  return heads;
}

interface MergeUpAt {
  repo: string;
  baseRef: string;
  reviewed: string;
  current: string;
}

/**
 * The proof that `current` is Shepherd's own clean merge of the base into `reviewed`, so a release at `reviewed` covers it:
 * its update-branch made the head, the head's first parent is `reviewed`, its second is on the base branch, and its tree is
 * git's clean merge-tree of the two. A seat push, an extra commit, a conflict resolution or a probe that fails gives none.
 */
export async function mergeUpProof(reads: MergeUpReads, at: MergeUpAt): Promise<Vouch | undefined> {
  if (!reads.ownUpdates().has(at.current)) return undefined;
  const result = await reads.carry({ repo: at.repo, baseRef: at.baseRef, fromHead: at.reviewed, head: at.current }).catch((): CarryResult => ({ equal: false }));
  if (!isCleanMergeUpOf(result, new Set([at.reviewed])) || result.base === undefined) return undefined;
  return { fromHead: at.reviewed, head: at.current, baseRef: at.baseRef, base: result.base };
}
