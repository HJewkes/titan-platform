import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { Registration, ShepherdStore } from "./store.js";
import { EXIT } from "@titan-design/registry";

export const ReleaseHeadArg = z.string().regex(/^[0-9a-f]{40}$/, "must be the 40-character head sha the hold was reviewed at");

const OWNER_ONLY = "only the owner releases an owner-asked hold: titan-factory shepherd owner-release";

const refused = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** A release is a statement about one head, the one the seat reviewed: a PR at another head, or a head that cannot be read, refuses it. */
async function assertReleasableAt(port: GitHubPort, repo: RepoSlug, pr: number, head: string): Promise<void> {
  const now = await port.getPr(repo, pr).then((read) => read.headSha, () => undefined);
  if (now === undefined) throw refused(`${repo}#${pr}: the PR's head could not be read, so the release is refused`, EXIT.UNAVAILABLE);
  if (now !== head) throw refused(`${repo}#${pr} is at ${now}, not ${head}: review the new head, then release at it`, EXIT.DATAERR);
}

/** Which hold a release lifts: the one of `holdClass`, or the run's only hold when none is named. */
interface ReleaseAt {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  actor: string;
  holdClass?: string;
}

/**
 * Releases one hold, recording the head so a later move off it is known, and returns the registration with the hold still
 * in force, if any. A run that is not held is refused, so no release event is written for nothing. So is a class the run
 * holds no hold of, and a release that names no class while a `g10-adversary` hold sits over another: it must not be
 * counted as the adversary release when its caller meant the other hold. An owner-asked hold is never lifted here: a run
 * held by it alone is refused.
 */
export async function releaseAtHead(store: ShepherdStore, port: GitHubPort, at: ReleaseAt): Promise<Registration> {
  const ref = `${at.repo}#${at.pr}`;
  const registration = store.byRun(at.runId);
  if (!registration?.held) throw refused(`${ref} is not held, so there is nothing to release`, EXIT.DATAERR);
  await assertReleasableAt(port, at.repo, at.pr, at.head);
  if (store.releaseClass(at.runId, at.holdClass, { actor: at.actor, headSha: at.head })) return store.byRun(at.runId)!;
  if (registration.ownerHold && at.holdClass === undefined) throw refused(`${ref}: ${OWNER_ONLY}, so nothing was released`, EXIT.DATAERR);
  if (at.holdClass !== undefined) throw refused(`${ref} holds no ${at.holdClass} hold, so nothing was released`, EXIT.DATAERR);
  throw refused(`${ref} holds a g10-adversary hold over a hold of another class: name the one to release with --class, so nothing was released`, EXIT.DATAERR);
}
