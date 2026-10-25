import { RESOLVER_CLASSES } from "@titan-design/authority";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import { EXIT } from "@titan-design/registry";
import type { GateBatchStore } from "../gate-batch-store.js";
import { holdReleaseRefusal, spendHoldRelease, type OwnerHeldAt } from "../owner-release-presence.js";
import { assertReleasableAt } from "./release-head.js";
import type { Registration, ShepherdStore } from "./store.js";

interface OwnerReleaseAt {
  repo: RepoSlug;
  pr: number;
  /** The 40-character head the owner releases at; a PR at any other head is refused. */
  head: string;
}

const OWNER_CLASSES: readonly string[] = RESOLVER_CLASSES;

const refused = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** The run for owner/repo#pr while it carries an owner-asked hold; refused when it is unregistered or has none, so nothing is asked or written for nothing. */
export function ownerHeldRun(store: ShepherdStore, repo: RepoSlug, pr: number): Registration {
  const registration = store.byPr(repo, pr);
  if (!registration) throw refused(`${repo}#${pr} is not registered with shepherd`, EXIT.NOINPUT);
  if (!registration.ownerHold) throw refused(`${repo}#${pr} holds no owner-asked hold, so there is nothing to release`, EXIT.DATAERR);
  return registration;
}

/** The release event's actor: the resolver class and id, and the presence proof when one was given. */
const actorOf = ({ class: resolverClass, id, confirmEvent }: GateResolver): string => `${resolverClass}:${id}${confirmEvent ? ` proof ${confirmEvent}` : ""}`;

const liftedMeanwhile = (at: OwnerReleaseAt): Error => refused(`${at.repo}#${at.pr}'s owner-asked hold was lifted meanwhile, so nothing was released`, EXIT.DATAERR);

/** The owner-asked hold `at` names as it stands now, for the proof check; read after the head, so a hold placed meanwhile is the one checked. */
export function ownerHeldAt(store: ShepherdStore, runId: string, at: OwnerReleaseAt): OwnerHeldAt {
  const ownerHold = store.byRun(runId)?.ownerHold;
  if (!ownerHold) throw liftedMeanwhile(at);
  return { runId, repo: at.repo, pr: at.pr, head: at.head, ownerHold };
}

/**
 * Lifts the owner-asked hold on owner/repo#pr, and only that hold, for an owner resolver at the PR's current head. The
 * resolver class is checked first, so a coordinator or any agent class is refused before anything is read or written.
 * A `shepherd owner-release` resolver's confirmEvent must name an owner-signed hold-release record for this run, head
 * and hold (`holdReleaseRefusal`); the record is spent once admitted. Returns the registration after, with any other hold still in force.
 */
export async function ownerRelease(store: ShepherdStore, port: GitHubPort, at: OwnerReleaseAt, resolver: GateResolver, batches: GateBatchStore): Promise<Registration> {
  if (!OWNER_CLASSES.includes(resolver.class)) throw refused(`only the owner releases an owner-asked hold; ${resolver.class} ${resolver.id} is refused, so nothing was released`, EXIT.NOPERM);
  const { runId } = ownerHeldRun(store, at.repo, at.pr);
  const actor = actorOf(resolver);
  await assertReleasableAt(port, { ...at, runId, actor }, false);
  const proof = holdReleaseRefusal(batches, ownerHeldAt(store, runId, at), resolver);
  if (proof !== undefined) throw refused(`${proof}, so nothing was released`, EXIT.NOPERM);
  const released = store.releaseOwnerHold(runId, { actor, headSha: at.head });
  spendHoldRelease(batches, resolver, released);
  if (!released) throw liftedMeanwhile(at);
  return store.byRun(runId)!;
}
