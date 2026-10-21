import { gitOrNull } from "./git.js";
import type { WorktreeRecord } from "./reattach.js";
import { unsavedWork } from "./unsaved-work.js";
import { prepareIgnoredFiles, type ParkFileObserver } from "./park-ignored-files.js";
import {
  localBackingCandidates,
  localBackingRef,
  type ParkLocalBackingReader,
  type ParkLocalBackingObservation,
} from "./park-local-backing.js";
import {
  currentBranchRefusal,
  finishObservedPark,
  objectId,
  originBacking,
  originHeadChanged,
  parkAllocatedWorktree,
  parkOriginHead,
  parkPolicyAllocated,
  type OriginHead,
} from "./park-engine.js";
import type { ParkOptions } from "./park-options.js";
export type { ParkOptions } from "./park-options.js";
export type {
  ParkLocalBackingObservation,
  ParkLocalBackingCandidate,
  ParkLocalBackingReader,
} from "./park-local-backing.js";
export type {
  ParkIgnoredFilesObservation,
  ParkIgnoredFilesPolicy,
} from "./park-ignored-files.js";

type CandidateReader = (
  observation: Readonly<ParkLocalBackingObservation>
) => Promise<unknown>;
type LocalParkResult =
  | {
      ok: true;
      head: string;
      branch?: string;
      containedIn?: string;
      backingRef?: string;
    }
  | { ok: false; reason: string };
interface LocalProofContext {
  target: WorktreeRecord;
  observed: OriginHead;
  options: ParkOptions;
  files?: ParkFileObserver;
}
type BackingProof =
  | { containedIn?: string; backingRef?: string }
  | { reason: string };

async function candidateBacking(
  context: LocalProofContext,
  reader: CandidateReader
): Promise<BackingProof> {
  const { target, observed, options, files } = context;
  const backing = await originBacking(target, observed, options, files);
  if (!("reason" in backing)) return backing;
  const observation = { ...observed, worktree: target.worktree };
  const candidates = await localBackingCandidates(reader, observation);
  const afterReader = await originHeadChanged(target, observed, files);
  if (afterReader) return { reason: afterReader };
  const ref =
    candidates === undefined
      ? undefined
      : await localBackingRef(candidates, observation);
  const afterProbes = await originHeadChanged(target, observed, files);
  if (afterProbes) return { reason: afterProbes };
  return ref === undefined ? backing : { backingRef: ref };
}

async function observedHead(
  target: WorktreeRecord
): Promise<OriginHead | { reason: string }> {
  const branch = await gitOrNull(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    target.worktree
  );
  const head = await gitOrNull(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    target.worktree
  );
  return branch === null || head === null || !objectId(head)
    ? { reason: currentBranchRefusal(target, branch) }
    : { branch, head };
}

/** Optional local candidate proof never changes the ordinary no-reader origin path. */
async function parkLocalBacking(
  target: WorktreeRecord,
  recheck: () => string | undefined,
  options: ParkOptions,
  reader: CandidateReader,
  files?: ParkFileObserver
): Promise<LocalParkResult> {
  const observed = await observedHead(target);
  if ("reason" in observed) return { ok: false, reason: observed.reason };
  const initial = files ? await files() : await unsavedWork(target.worktree);
  if (initial) return { ok: false, reason: initial };
  const context: LocalProofContext = {
    target,
    observed,
    options,
    ...(files ? { files } : {}),
  };
  const backing = await candidateBacking(context, reader);
  if ("reason" in backing) return { ok: false, reason: backing.reason };
  const result = await finishObservedPark(target, observed, recheck, files);
  return result.ok
    ? { ...result, branch: observed.branch, ...backing }
    : result;
}

function candidateReader(
  target: WorktreeRecord,
  options: ParkOptions
): CandidateReader | { reason: string } | undefined {
  let reader: unknown;
  try {
    reader = options.localBackingCandidates;
    if (
      reader !== undefined &&
      (typeof reader !== "function" || options.allowOriginHeadAncestor !== true)
    )
      return {
        reason:
          "local-backing candidates require an origin-head reader opt-in in " +
          target.worktree +
          "; not parked",
      };
  } catch {
    return {
      reason:
        "invalid local-backing reader in " + target.worktree + "; not parked",
    };
  }
  return typeof reader !== "function"
    ? undefined
    : async (observation) => {
        const value: unknown = Reflect.apply(reader, undefined, [observation]);
        return value;
      };
}

function dispatchPark(
  target: WorktreeRecord,
  recheck: () => string | undefined,
  options: ParkOptions,
  reader: CandidateReader | undefined,
  files?: ParkFileObserver
): Promise<LocalParkResult> {
  if (reader) return parkLocalBacking(target, recheck, options, reader, files);
  if (options.allowOriginHeadAncestor === true)
    return parkOriginHead(target, recheck, options, files);
  return files
    ? parkPolicyAllocated(target, recheck, options, files)
    : parkAllocatedWorktree(target, recheck, options);
}

/** A selected local candidate adds only its opaque correlation; ordinary origin success has no backingRef. */
export function parkWorktree(
  target: WorktreeRecord,
  recheck: (() => string | undefined) | undefined,
  options: ParkOptions & {
    allowOriginHeadAncestor: true;
    localBackingCandidates: ParkLocalBackingReader;
  }
): Promise<
  | {
      ok: true;
      head: string;
      branch: string;
      containedIn?: string;
      backingRef?: string;
    }
  | { ok: false; reason: string }
>;
/** Explicit origin-head proof reports the actual retained branch and any differently named backing head. */
export function parkWorktree(
  target: WorktreeRecord,
  recheck: (() => string | undefined) | undefined,
  options: ParkOptions & { allowOriginHeadAncestor: true }
): Promise<
  | { ok: true; head: string; branch: string; containedIn?: string }
  | { ok: false; reason: string }
>;
/** Refuse file loss, recheck lifecycle immediately before nonforced removal, and always keep the local branch. */
export function parkWorktree(
  target: WorktreeRecord,
  recheck?: () => string | undefined,
  options?: ParkOptions
): Promise<{ ok: true; head: string } | { ok: false; reason: string }>;
export async function parkWorktree(
  target: WorktreeRecord,
  recheck: () => string | undefined = () => undefined,
  options: ParkOptions = {}
): Promise<LocalParkResult> {
  const reader = candidateReader(target, options);
  if (reader !== undefined && typeof reader !== "function")
    return { ok: false, reason: reader.reason };
  let ignored: unknown;
  try {
    ignored = options.ignoredFiles;
  } catch {
    return {
      ok: false,
      reason:
        "invalid ignored-file policy in " + target.worktree + "; not parked",
    };
  }
  if (ignored === undefined)
    return dispatchPark(target, recheck, options, reader);
  const files = prepareIgnoredFiles(ignored, target.worktree);
  return typeof files === "function"
    ? dispatchPark(target, recheck, options, reader, files)
    : { ok: false, reason: files.reason };
}
