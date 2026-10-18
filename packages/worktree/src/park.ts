import { fetchDefaultTip } from "./branch-base.js";
import { gitOrNull, gitText as git } from "./git.js";
import { DEFAULT_FETCH_TIMEOUT_MS, type WorktreeOptions } from "./options.js";
import type { WorktreeRecord } from "./reattach.js";
import { unsavedWork } from "./unsaved-work.js";
import {
  prepareIgnoredFiles,
  type ParkFileObserver,
  type ParkIgnoredFilesPolicy,
} from "./park-ignored-files.js";
import {
  localBackingCandidates,
  localBackingRef,
  type ParkLocalBackingReader,
  type ParkLocalBackingObservation,
} from "./park-local-backing.js";
export type {
  ParkLocalBackingObservation,
  ParkLocalBackingCandidate,
  ParkLocalBackingReader,
} from "./park-local-backing.js";
export type {
  ParkIgnoredFilesObservation,
  ParkIgnoredFilesPolicy,
} from "./park-ignored-files.js";

/** Parking keeps the local branch; an opt-in fresh default proof can establish its commits are already backed. */
export interface ParkOptions {
  /** Lazy caller-supplied local commit backing; requires allowOriginHeadAncestor strictly true. */
  localBackingCandidates?: ParkLocalBackingReader;
  /** Explicit policy over fresh ignored files only; dirty status and failed observations always refuse. */
  ignoredFiles?: ParkIgnoredFilesPolicy;
  /** Retain the actual branch when tracking or a fresh origin-head ancestry proof backs its HEAD. */
  allowOriginHeadAncestor?: boolean;
  /** Permit a missing origin/branch only when a fresh DEFAULT fetch contains the actual HEAD. */
  allowDefaultBranchAncestor?: boolean;
  /** Positive finite fetch budget; invalid values refuse without fetching. Defaults to 15 seconds. */
  fetchTimeoutMs?: WorktreeOptions["fetchTimeoutMs"];
}

interface PushProof {
  refusal?: string;
  provedHead?: string;
}

const missingBranch = (target: WorktreeRecord): string =>
  `${target.branch} is not on origin; push it first`;

/** Only a strict fetched tip can back the actual current HEAD; local fallback is not evidence. */
async function defaultAncestryProof(
  target: WorktreeRecord,
  options: ParkOptions
): Promise<PushProof> {
  const timeout = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (
    options.allowDefaultBranchAncestor !== true ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  )
    return { refusal: missingBranch(target) };
  const tip = await fetchDefaultTip(target.worktree, timeout);
  const head =
    typeof tip === "string"
      ? null
      : await gitOrNull(
          ["rev-parse", "--verify", "HEAD^{commit}"],
          target.worktree
        );
  if (
    typeof tip === "string" ||
    head === null ||
    (await gitOrNull(
      ["merge-base", "--is-ancestor", head, tip.sha],
      target.worktree
    )) === null
  )
    return { refusal: missingBranch(target) };
  return { provedHead: head };
}

/** With an origin, the branch must be backed there; without one, the kept local branch is the copy. */
async function unpushed(
  target: WorktreeRecord,
  options: ParkOptions
): Promise<PushProof> {
  const { worktree, branch } = target;
  if ((await gitOrNull(["remote", "get-url", "origin"], worktree)) === null)
    return {};
  if (
    (await gitOrNull(
      ["rev-parse", "--verify", "--quiet", `origin/${branch}`],
      worktree
    )) === null
  )
    return defaultAncestryProof(target, options);
  const ahead = await gitOrNull(
    ["rev-list", `origin/${branch}..HEAD`],
    worktree
  );
  if (ahead === null)
    return { refusal: `could not compare ${worktree} with origin/${branch}` };
  const count = ahead.split("\n").filter(Boolean).length;
  return count === 0
    ? {}
    : {
        refusal: `${count} commit(s) in ${worktree} are not on origin/${branch}; push first`,
      };
}

/** A commit on another branch would lose the expected branch relationship when the tree is removed. */
async function offBranch(target: WorktreeRecord): Promise<string | undefined> {
  const head = await gitOrNull(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    target.worktree
  );
  if (head === target.branch) return undefined;
  const where = head === null ? "detached" : `on ${head}`;
  return `HEAD in ${target.worktree} is ${where}, not on ${target.branch}; check out ${target.branch} first`;
}

/** Async fetch and caller checks can outlive the initial snapshot; keep the proof bound to files, branch and HEAD. */
async function proofChanged(
  target: WorktreeRecord,
  provedHead: string
): Promise<string | undefined> {
  const refusal =
    (await unsavedWork(target.worktree)) ?? (await offBranch(target));
  if (refusal) return refusal;
  const head = await gitOrNull(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    target.worktree
  );
  return head === provedHead ? undefined : missingBranch(target);
}

async function removeParked(
  target: WorktreeRecord,
  head: string
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  try {
    await git(["worktree", "remove", target.worktree], target.gitRoot);
  } catch (err) {
    const detail = String(
      (err as { stderr?: unknown }).stderr || (err as Error).message
    ).trim();
    return {
      ok: false,
      reason: `git would not remove ${target.worktree}: ${
        detail.split("\n")[0]
      }`,
    };
  }
  return { ok: true, head };
}

/** Refuse file loss, recheck lifecycle immediately before nonforced removal, and always keep the local branch. */
async function parkAllocatedWorktree(
  target: WorktreeRecord,
  recheck: () => string | undefined = () => undefined,
  options: ParkOptions = {}
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const refusal =
    (await offBranch(target)) ?? (await unsavedWork(target.worktree));
  if (refusal) return { ok: false, reason: refusal };
  const proof = await unpushed(target, options);
  if (proof.refusal) return { ok: false, reason: proof.refusal };
  const changed =
    proof.provedHead === undefined
      ? undefined
      : await proofChanged(target, proof.provedHead);
  if (changed) return { ok: false, reason: changed };
  const head =
    proof.provedHead ?? (await git(["rev-parse", "HEAD"], target.worktree));
  const late = recheck();
  if (late) return { ok: false, reason: late };
  const final =
    proof.provedHead === undefined
      ? undefined
      : await proofChanged(target, proof.provedHead);
  if (final) return { ok: false, reason: final };
  return removeParked(target, head);
}

interface OriginHead {
  branch: string;
  head: string;
}

/** Git arguments must be complete object IDs, never option-like remote output. */
const objectId = (value: string): boolean =>
  (value.length === 40 || value.length === 64) && !/[^0-9a-f]/iu.test(value);

function currentBranchRefusal(target: WorktreeRecord, branch: string | null): string {
  const where = branch === null ? "detached" : `on ${branch}`;
  return `HEAD in ${target.worktree} is ${where}, not on ${target.branch}; check out ${target.branch} first`;
}

/** Only a currently listed head with a locally usable tip can back the observed HEAD. */
async function containingOriginHead(
  target: WorktreeRecord,
  observed: OriginHead,
  options: ParkOptions
): Promise<string | undefined> {
  const timeout = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  const listed = await gitOrNull(["ls-remote", "--heads", "origin"], target.worktree, timeout);
  for (const line of (listed ?? "").split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !objectId(sha) || !ref?.startsWith("refs/heads/") || ref.length === "refs/heads/".length) continue;
    if ((await gitOrNull(["merge-base", "--is-ancestor", observed.head, sha], target.worktree)) !== null)
      return ref.slice("refs/heads/".length);
  }
  return undefined;
}

/** Preserve existing tracking/default policy, but compare against the captured actual branch and HEAD. */
async function originHeadRefusal(
  target: WorktreeRecord,
  observed: OriginHead,
  options: ParkOptions
): Promise<string | undefined> {
  if ((await gitOrNull(["remote", "get-url", "origin"], target.worktree)) === null) return undefined;
  const tracking = `origin/${observed.branch}`;
  if ((await gitOrNull(["rev-parse", "--verify", "--quiet", tracking], target.worktree)) === null) {
    if (observed.branch !== target.branch) return `${observed.branch} is not on origin; push it first`;
    const proof = await defaultAncestryProof(target, options);
    return proof.refusal === undefined && proof.provedHead === observed.head ? undefined : missingBranch(target);
  }
  const ahead = await gitOrNull(["rev-list", `${tracking}..${observed.head}`], target.worktree);
  if (ahead === null) return `could not compare ${target.worktree} with ${tracking}`;
  const count = ahead.split("\n").filter(Boolean).length;
  return count === 0 ? undefined : `${count} commit(s) in ${target.worktree} are not on ${tracking}; push first`;
}

async function originHeadChanged(target: WorktreeRecord, observed: OriginHead, files?: ParkFileObserver): Promise<string | undefined> {
  const dirty = files ? await files() : await unsavedWork(target.worktree);
  if (dirty) return dirty;
  const branch = await gitOrNull(["symbolic-ref", "--quiet", "--short", "HEAD"], target.worktree);
  const head = await gitOrNull(["rev-parse", "--verify", "HEAD^{commit}"], target.worktree);
  if (branch !== observed.branch || head !== observed.head)
    return `HEAD in ${target.worktree} changed while checking origin backing; not parked`;
  return undefined;
}

async function originBacking(
  target: WorktreeRecord,
  observed: OriginHead,
  options: ParkOptions,
  files?: ParkFileObserver
): Promise<{ containedIn?: string } | { reason: string }> {
  const { branch } = observed;
  let containedIn: string | undefined;
  if (branch !== target.branch) {
    const tracking = await gitOrNull(["rev-parse", "--verify", "--quiet", `origin/${branch}`], target.worktree);
    if (tracking === null) {
      containedIn = await containingOriginHead(target, observed, options);
      if (containedIn === undefined) return { reason: currentBranchRefusal(target, branch) };
    }
  }
  const dirty = files ? await files() : await unsavedWork(target.worktree);
  if (dirty) return { reason: dirty };
  if (containedIn === undefined) {
    const refusal = await originHeadRefusal(target, observed, options);
    if (refusal !== undefined) {
      containedIn = await containingOriginHead(target, observed, options);
      if (containedIn === undefined) return { reason: refusal };
    }
  }
  return containedIn === undefined ? {} : { containedIn };
}

async function parkOriginHead(
  target: WorktreeRecord,
  recheck: () => string | undefined,
  options: ParkOptions,
  files?: ParkFileObserver
): Promise<{ ok: true; head: string; branch: string; containedIn?: string } | { ok: false; reason: string }> {
  const branch = await gitOrNull(["symbolic-ref", "--quiet", "--short", "HEAD"], target.worktree);
  const head = await gitOrNull(["rev-parse", "--verify", "HEAD^{commit}"], target.worktree);
  if (branch === null || head === null || !objectId(head))
    return { ok: false, reason: currentBranchRefusal(target, branch) };
  const observed = { branch, head };
  const initial = files ? await files() : undefined;
  if (initial) return { ok: false, reason: initial };
  const backing = await originBacking(target, observed, options, files);
  if ("reason" in backing) return { ok: false, reason: backing.reason };
  const result = await finishObservedPark(target, observed, recheck, files);
  return result.ok ? { ...result, branch, ...backing } : result;
}

async function finishObservedPark(
  target: WorktreeRecord,
  observed: OriginHead,
  recheck: () => string | undefined,
  files?: ParkFileObserver
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const changed = await originHeadChanged(target, observed, files);
  if (changed) return { ok: false, reason: changed };
  const late = recheck();
  if (late) return { ok: false, reason: late };
  const final = await originHeadChanged(target, observed, files);
  if (final) return { ok: false, reason: final };
  return removeParked(target, observed.head);
}

async function parkPolicyAllocated(
  target: WorktreeRecord,
  recheck: () => string | undefined,
  options: ParkOptions,
  files: ParkFileObserver
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const off = await offBranch(target);
  if (off) return { ok: false, reason: off };
  const head = await gitOrNull(["rev-parse", "--verify", "HEAD^{commit}"], target.worktree);
  if (head === null || !objectId(head)) return { ok: false, reason: "could not read HEAD in " + target.worktree + "; not parked" };
  const dirty = await files();
  if (dirty) return { ok: false, reason: dirty };
  const observed = { branch: target.branch, head };
  const refusal = await originHeadRefusal(target, observed, options);
  if (refusal) return { ok: false, reason: refusal };
  return finishObservedPark(target, observed, recheck, files);
}

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
