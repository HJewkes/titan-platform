import { setTimeout as sleep } from "node:timers/promises";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import type { Vouch } from "./hold-slot-rows.js";
import { holdClassOf } from "./g10-release.js";
import { mergeUpProof, type MergeUpReads } from "./merge-up-release.js";
import type { Registration, ShepherdStore } from "./store.js";
import { EXIT } from "@titan-design/registry";

export const ReleaseHeadArg = z.string().regex(/^[0-9a-f]{40}$/, "must be the 40-character head sha the hold was reviewed at");

const OWNER_ONLY = "only the owner releases an owner-asked hold, from their own terminal: titan-factory shepherd owner-release <owner/repo#n> --head <sha>";

const refused = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** Which hold a release lifts: the one of `holdClass`, or the run's only hold when none is named. */
interface ReleaseAt {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  actor: string;
  holdClass?: string;
}

const G10_CLASSES: ReadonlySet<string> = new Set(["g10-review", "g10-adversary"]);

/**
 * Only a G10 release may name a head Shepherd has since merged the base into: land's own update-branch merges main into a
 * held PR whenever it reads behind, and a seat review covers the PR's diff, which a clean merge-up leaves as it was.
 */
const liftsG10 = (registration: Registration, holdClass: string | undefined): boolean =>
  G10_CLASSES.has(holdClass ?? holdClassOf(registration.holdReason) ?? "");

/** A release's merge-up reads, plus whether the run's own update-branch step is still running. */
export interface ReleaseReads extends MergeUpReads {
  updating: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const UPDATE_POLL_MS = 2_000;
const UPDATE_POLLS = 30;

/** True while an `update-branch` step of the run, the land loop's or a freeze-hold refresh's, has not yet recorded its result. */
export const updateBranchRunning = (run: WorkflowRun): boolean => Object.values(run.activeSteps).some((active) => stepIdMatches("update-branch", active.stepId));

/**
 * GitHub shows an update-branch merge seconds before the step that asked for it records the head as Shepherd's own, so a
 * release in that window waits, a bounded time, for the record. True when it waited, so the caller reads the head again.
 */
async function awaitedOwnUpdate(reads: ReleaseReads, head: string): Promise<boolean> {
  const pending = () => !reads.ownUpdates().has(head) && reads.updating();
  if (!pending()) return false;
  for (let poll = 0; poll < UPDATE_POLLS && pending(); poll++) await (reads.sleep ?? sleep)(UPDATE_POLL_MS);
  return true;
}

async function prAt(port: GitHubPort, at: ReleaseAt): Promise<{ headSha: string; baseRef: string }> {
  const now = await port.getPr(at.repo, at.pr).catch(() => undefined);
  if (now === undefined) throw refused(`${at.repo}#${at.pr}: the PR's head could not be read, so the release is refused`, EXIT.UNAVAILABLE);
  return now;
}

function notReleasable(at: ReleaseAt, headSha: string, reads: ReleaseReads | undefined): Error {
  const ref = `${at.repo}#${at.pr} is at ${headSha}, not ${at.head}`;
  if (reads?.updating()) return refused(`${ref}, and Shepherd's own update-branch has not recorded it yet: release again once it has`, EXIT.TEMPFAIL);
  return refused(`${ref}, and is no clean merge-up Shepherd made of it: review the new head, then release at it`, EXIT.DATAERR);
}

/**
 * A release is a statement about one head, the one the seat reviewed: a head that cannot be read refuses it, and so does a
 * PR at another head, unless the release lifts a G10 hold and that head is Shepherd's own clean merge-up of the reviewed
 * one. Then the proof comes back, so the release records which head it carries to. A head read while the run's own
 * update-branch is still recording is read again once it has, so a push in the meantime is the head the proof must cover.
 */
export async function assertReleasableAt(port: GitHubPort, at: ReleaseAt, g10: boolean, reads?: ReleaseReads): Promise<Vouch | undefined> {
  let now = await prAt(port, at);
  if (now.headSha === at.head) return undefined;
  const merged = g10 ? reads : undefined;
  if (merged && (await awaitedOwnUpdate(merged, now.headSha))) now = await prAt(port, at);
  if (now.headSha === at.head) return undefined;
  const proof = merged ? await mergeUpProof(merged, { repo: at.repo, baseRef: now.baseRef, reviewed: at.head, current: now.headSha }) : undefined;
  if (proof === undefined) throw notReleasable(at, now.headSha, merged);
  return proof;
}

/**
 * Releases one hold, recording the reviewed head so a later move off it is known, and returns the registration with the
 * hold still in force, if any. A release across Shepherd's merge-up also records that merge-up's proof, from the reviewed
 * head to the PR's head. A run that is not held is refused, so no release event is written for nothing. So is a class the
 * run holds no hold of, and a release that names no class while a `g10-adversary` hold sits over another: it must not be
 * counted as the adversary release when its caller meant the other hold. An owner-asked hold is never lifted here: a run
 * held by it alone is refused.
 */
export async function releaseAtHead(store: ShepherdStore, port: GitHubPort, at: ReleaseAt, reads?: ReleaseReads): Promise<Registration> {
  const ref = `${at.repo}#${at.pr}`;
  const registration = store.byRun(at.runId);
  if (!registration?.held) throw refused(`${ref} is not held, so there is nothing to release`, EXIT.DATAERR);
  const proof = await assertReleasableAt(port, at, liftsG10(registration, at.holdClass), reads);
  if (store.releaseClass(at.runId, at.holdClass, { actor: at.actor, headSha: at.head })) {
    if (proof) store.vouch(at.runId, proof);
    return store.byRun(at.runId)!;
  }
  if (registration.ownerHold && at.holdClass === undefined) throw refused(`${ref}: ${OWNER_ONLY}, so nothing was released`, EXIT.DATAERR);
  if (at.holdClass !== undefined) throw refused(`${ref} holds no ${at.holdClass} hold, so nothing was released`, EXIT.DATAERR);
  throw refused(`${ref} holds a g10-adversary hold over a hold of another class: name the one to release with --class, so nothing was released`, EXIT.DATAERR);
}
