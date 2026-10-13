import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { Vouch } from "./hold-slot-rows.js";
import { isAdversaryHold } from "./hold-slots.js";
import { mergeUpProof, type MergeUpReads } from "./merge-up-release.js";
import type { Registration, ShepherdStore } from "./store.js";
import { EXIT } from "@titan-design/registry";

export const ReleaseHeadArg = z.string().regex(/^[0-9a-f]{40}$/, "must be the 40-character head sha the hold was reviewed at");

const OWNER_ONLY = "only the owner releases an owner-asked hold, from their own terminal: titan-factory shepherd owner-release <owner/repo#n> --head <sha>";

const refused = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** Which hold a release lifts: the one of `holdClass`, or the run's only hold when none is named. */
export interface ReleaseAt {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  actor: string;
  holdClass?: string;
}

/** Only a `g10-adversary` release may name a head Shepherd has since merged the base into. */
const liftsAdversary = (registration: Registration, holdClass: string | undefined): boolean =>
  holdClass === undefined ? isAdversaryHold(registration.holdReason) : holdClass === "g10-adversary";

/**
 * A release is a statement about one head, the one the seat reviewed: a head that cannot be read refuses it, and so does a
 * PR at another head, unless the release lifts a `g10-adversary` hold and that head is Shepherd's own clean merge-up of the
 * reviewed one. Then the proof comes back, so the release records which head it carries to.
 */
export async function assertReleasableAt(port: GitHubPort, at: ReleaseAt, adversary: boolean, reads?: MergeUpReads): Promise<Vouch | undefined> {
  const now = await port.getPr(at.repo, at.pr).catch(() => undefined);
  if (now === undefined) throw refused(`${at.repo}#${at.pr}: the PR's head could not be read, so the release is refused`, EXIT.UNAVAILABLE);
  if (now.headSha === at.head) return undefined;
  const proof = adversary && reads ? await mergeUpProof(reads, { repo: at.repo, baseRef: now.baseRef, reviewed: at.head, current: now.headSha }) : undefined;
  if (proof === undefined) throw refused(`${at.repo}#${at.pr} is at ${now.headSha}, not ${at.head}, and is no clean merge-up Shepherd made of it: review the new head, then release at it`, EXIT.DATAERR);
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
export async function releaseAtHead(store: ShepherdStore, port: GitHubPort, at: ReleaseAt, reads?: MergeUpReads): Promise<Registration> {
  const ref = `${at.repo}#${at.pr}`;
  const registration = store.byRun(at.runId);
  if (!registration?.held) throw refused(`${ref} is not held, so there is nothing to release`, EXIT.DATAERR);
  const proof = await assertReleasableAt(port, at, liftsAdversary(registration, at.holdClass), reads);
  if (store.releaseClass(at.runId, at.holdClass, { actor: at.actor, headSha: at.head })) {
    if (proof) store.vouch(at.runId, proof);
    return store.byRun(at.runId)!;
  }
  if (registration.ownerHold && at.holdClass === undefined) throw refused(`${ref}: ${OWNER_ONLY}, so nothing was released`, EXIT.DATAERR);
  if (at.holdClass !== undefined) throw refused(`${ref} holds no ${at.holdClass} hold, so nothing was released`, EXIT.DATAERR);
  throw refused(`${ref} holds a g10-adversary hold over a hold of another class: name the one to release with --class, so nothing was released`, EXIT.DATAERR);
}
