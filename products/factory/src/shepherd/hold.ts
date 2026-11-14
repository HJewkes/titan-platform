import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { parseVerdictBlock } from "@titan-design/session-read";
import { failedStep } from "./failure-class.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute } from "../workflows/land.js";
import { acceptExternalVerdict, externalReviewer, latestSession, readNamedReviewer } from "./external-review.js";
import type { FreezeGuard } from "./freeze.js";
import { HOLD_POLL_MS, type HeldCheck, type HoldTiming, type TakeRecheck } from "./hold-timing.js";
import { independentOfRun, type Lineage } from "./lineage.js";
import type { HoldLookup, Registration, ShepherdStore } from "./store.js";
import { openOrRead } from "./snapshot-reads.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import type { CarryInput, CarryResult } from "./tree-carry.js";
import { CARRYING_KINDS } from "./carry-kinds.js";
import { namesPr, type ReviewerAgent, type ReviewerReader } from "@titan-design/review-panel";

export class MergeHeldError extends Error {
  override readonly name = "MergeHeldError";
}

/** The open PR's head now; undefined for a PR merged or closed elsewhere. */
type OpenHeadRead = (repo: RepoSlug, pr: number) => Promise<string | undefined>;

/** Reads the hold's named reviewer at `sha` and records the newest verdict there: MERGE satisfies the hold, FIX_FIRST withdraws it. */
export type HoldSatisfier = (repo: RepoSlug, pr: number, sha: string, baseRef: string) => Promise<void>;

interface HoldSatisfierDeps {
  store: () => ShepherdStore;
  roster: () => Promise<readonly ReviewerAgent[]>;
  /** Every generation, retired ones included, that proves the reviewer independent; absent means `roster` stands for it. */
  lineage?: () => Promise<Lineage>;
  reader: ReviewerReader;
  /** The `sh-carry` probe; absent means a satisfaction never moves to another head. */
  carry?: (input: CarryInput) => Promise<CarryResult>;
}

/** A reviewer not on the roster, or one not provably independent of the code's authors, changes nothing; a read that fails, a damaged transcript included, withdraws a satisfaction at this head and never keeps or grants one. A roster outage leaves the hold as it is, so an existing satisfaction stays until the roster reads again. */
export function holdSatisfier(deps: HoldSatisfierDeps): HoldSatisfier {
  return async (repo, pr, sha, baseRef) => {
    const store = deps.store();
    const registration = store.byPr(repo, pr);
    const reviewer = externalReviewer(registration);
    if (registration === undefined || reviewer === undefined) return;
    const roster = await deps.roster().catch((error: unknown): undefined => {
      console.error(`shepherd: ${repo}#${pr}: the roster could not be read, so the hold stays as it is: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    if (roster === undefined) return;
    const row = latestSession(reviewer, roster);
    if (row === undefined) return;
    const lineage = deps.lineage ? await deps.lineage().catch(unreadLineage(repo, pr)) : { rows: roster, complete: true };
    if (lineage === undefined || !independentOfRun(row, registration, lineage, store.authorsOf(registration.runId))) return;
    const read = { repo, pr, head: sha, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
    const messages = await readNamedReviewer(deps.reader, read).catch((): undefined => undefined);
    if (messages === undefined) return registration.holdSatisfied?.head === sha ? store.unsatisfyHold(registration.runId) : undefined;
    const verdict = acceptExternalVerdict({ repo, pr, head: sha, external: reviewer }, row, messages);
    if (verdict.kind === "none" && verdict.reason === "wait" && registration.holdSatisfied?.head === sha) return store.unsatisfyHold(registration.runId);
    if (verdict.kind !== "verdict") {
      const sessions = roster.filter((agent) => agent.name === reviewer && agent.sessionId !== "");
      return carrySatisfaction(deps, registration, { repo, baseRef, head: sha }, await newestOwn(deps.reader, sessions, repo, pr));
    }
    if (verdict.verdict === "FIX_FIRST") return store.unsatisfyHold(registration.runId);
    if (registration.holdSatisfied?.head === sha) return;
    store.satisfyHold(registration.runId, reviewer, sha, { ...verdict.reviewer, locator: { ...verdict.locator } });
  };
}

/** The newest verdict block on this PR in any session under the reviewer's name, at any head, so a FIX_FIRST at a head nobody asked about still stops a carry past it; on a tie in time a FIX_FIRST or WAIT wins; a WAIT stops a carry without unsatisfying, and so does a session whose read fails. */
async function newestOwn(reader: ReviewerReader, rows: readonly ReviewerAgent[], repo: RepoSlug, pr: number): Promise<"MERGE" | "FIX_FIRST" | "WAIT" | undefined> {
  let newest: { at: number; verdict: "MERGE" | "FIX_FIRST" | "WAIT" } | undefined;
  for (const row of rows) {
    const messages = await readNamedReviewer(reader, { repo, pr, head: "", reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 }).catch((): undefined => undefined);
    if (messages === undefined) return "WAIT";
    for (const message of messages) {
      const block = parseVerdictBlock(message.text);
      const verdict = block.ok ? block.verdict : block.reason === "wait" ? "WAIT" : undefined;
      if (message.agentId !== row.agentId || message.sessionId !== row.sessionId || !verdict || !("repo" in block) || !namesPr(block, { repo, pr })) continue;
      if (!newest || message.writtenAt > newest.at || (message.writtenAt === newest.at && verdict !== "MERGE")) newest = { at: message.writtenAt, verdict };
    }
  }
  return newest?.verdict;
}

/** A satisfaction at an ancestor head moves to a tree-equal update of it; only the probe's answer decides, and a kind that does not carry never moves. */
async function carrySatisfaction(deps: HoldSatisfierDeps, registration: Registration, at: { repo: RepoSlug; baseRef: string; head: string }, newest: "MERGE" | "FIX_FIRST" | "WAIT" | undefined): Promise<void> {
  const { holdSatisfied, holdReviewer } = registration;
  if (newest === "FIX_FIRST") return deps.store().unsatisfyHold(registration.runId);
  if (newest === "WAIT" || !deps.carry || !holdSatisfied || !holdReviewer || holdSatisfied.head === at.head || !CARRYING_KINDS.has(registration.kind)) return;
  const result = await deps.carry({ repo: at.repo, baseRef: at.baseRef, fromHead: holdSatisfied.head, head: at.head });
  if (!result.equal || !result.headTree || result.headTree !== result.mergeTree) return;
  deps.store().satisfyHold(registration.runId, holdReviewer, at.head, { agentId: holdSatisfied.by.agentId, sessionId: holdSatisfied.by.sessionId, locator: holdSatisfied.by.locator });
}

/** A lineage outage leaves the hold as it is, like a roster outage. */
const unreadLineage = (repo: RepoSlug, pr: number) => (error: unknown): undefined => {
  console.error(`shepherd: ${repo}#${pr}: the lineage could not be read, so the hold stays as it is: ${error instanceof Error ? error.message : String(error)}`);
  return undefined;
};

/** The first guard that names a reason decides; later guards are not read. */
export function firstReason(...guards: readonly FreezeGuard[]): FreezeGuard {
  return {
    async reason(port, repo, pr, baseRef, head, branch) {
      for (const guard of guards) {
        const reason = await guard.reason(port, repo, pr, baseRef, head, branch);
        if (reason !== undefined) return reason;
      }
      return undefined;
    },
  };
}

/** `snapshot` serves the PR read of a wait; the merge itself goes through `holdingPort`, which reads the PR from the port. */
export function heldCheck(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard, satisfy?: HoldSatisfier, snapshot?: PrSnapshot): HeldCheck {
  return async (repo, pr, sha) => {
    const lookup = holds();
    const { headRef, baseRef, state, merged, headSha } = await openOrRead(port, snapshot, repo, pr);
    if (merged || state === "closed") return undefined;
    const at = sha === undefined || sha === headSha ? headSha : undefined;
    if (at !== undefined) await satisfy?.(repo, pr, at, baseRef);
    return lookup.heldReason(repo, pr, headRef, at) ?? (await freeze?.reason(port, repo, pr, baseRef, headSha, headRef));
  };
}

/** Reads the head the way `heldCheck` does, through the snapshot when one is wired. */
export function openHeadRead(port: GitHubPort, snapshot?: PrSnapshot): OpenHeadRead {
  return async (repo, pr) => {
    const { state, merged, headSha } = await openOrRead(port, snapshot, repo, pr);
    return merged || state === "closed" ? undefined : headSha;
  };
}

/** The port handed to `landRoutes`: its merge refuses a held PR, and any PR of a frozen repo but the fix task's; any other PR passes straight through. */
export function holdingPort(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard, satisfy?: HoldSatisfier): GitHubPort {
  const held = heldCheck(port, holds, freeze, satisfy);
  return {
    ...port,
    merge: async (repo, pr, sha, method, message, expectedBase) => {
      const reason = await held(repo, pr, sha);
      if (reason !== undefined) throw new MergeHeldError(`${repo}#${pr} is held: ${reason}`);
      return port.merge(repo, pr, sha, method, message, expectedBase);
    },
  };
}

/** What the merge step answers after a wait: no merge, so land reads CI again, since the base or the head may have moved while it was held. */
export const AFTER_HOLD = { done: false, skipped: "held", mergeSha: "" };

/** Wraps the `merge` route so a held PR waits for release, abort-safe, instead of failing on the port's refusal. */
export function waitWhileHeld(
  route: StepRoute,
  held: HeldCheck,
  timing: HoldTiming,
  headNow: OpenHeadRead,
  reviewAsked?: ReviewAsked,
  reheld?: TakeRehold,
  recheck?: TakeRecheck,
  noteWait?: NoteWait,
): StepRoute {
  const afterHold = codeRoute(route.match, timing.now ?? Date.now, async () => AFTER_HOLD);
  return {
    ...route,
    runner: {
      run: async (input) => {
        let waited: boolean;
        try {
          waited = await untilReleased({ held, headNow, reviewAsked, reheld, recheck, noteWait }, JSON.parse(input.prompt) as MergeTarget, input.signal, timing);
        } catch (error) {
          return failedStep(route.match, error);
        }
        return (waited ? afterHold : route).runner.run(input);
      },
    },
  };
}

interface MergeTarget {
  repo: RepoSlug;
  pr: number;
  sha?: string;
}

/** True while a seat's `shepherd review` ask at `sha` waits for the run to take it. */
type ReviewAsked = (repo: RepoSlug, pr: number, sha: string) => boolean;

/** True once after the merge guard itself re-held the PR, which no CI read of the run has seen yet. */
export type TakeRehold = (repo: RepoSlug, pr: number) => boolean;

/** Records a new reason the merge waits on as a timeline row. */
type NoteWait = (repo: RepoSlug, pr: number, reason: string, sha: string | undefined) => void;

interface HoldReads {
  held: HeldCheck;
  headNow: OpenHeadRead;
  reviewAsked?: ReviewAsked;
  reheld?: TakeRehold;
  recheck?: TakeRecheck;
  noteWait?: NoteWait;
}

/**
 * True when the PR was held at least once before its release. A merge at `sha` can never go through once the head has
 * moved past it, so a push ends the wait too: land then reads CI and the run reviews the new head, where the same hold
 * applies. A head that cannot be read counts as not moved. A seat's ask for Shepherd's own review at `sha` ends the wait
 * with no merge too, so the run reads CI again and reviews that head. So does a re-hold the merge guard just placed: the
 * run's next CI read reports it and tells the seat. So does a g10 release due a fresh ask at `sha`: the CI read asks it.
 */
async function untilReleased({ held, headNow, reviewAsked, reheld, recheck, noteWait }: HoldReads, target: MergeTarget, signal: AbortSignal, timing: HoldTiming): Promise<boolean> {
  let told: string | undefined;
  for (let waited = false; ; waited = true) {
    signal.throwIfAborted();
    if (target.sha !== undefined && reviewAsked?.(target.repo, target.pr, target.sha)) return true;
    const reason = await held(target.repo, target.pr, target.sha);
    if (reason === undefined) return waited;
    // The merge step shows only as running, so the console and the timeline are where a long wait names what it waits on.
    if (reason !== told) {
      console.warn(`shepherd: the merge of ${target.repo}#${target.pr} waits: ${reason}`);
      noteWait?.(target.repo, target.pr, reason, target.sha);
    }
    told = reason;
    if (reheld?.(target.repo, target.pr)) return true;
    if (target.sha !== undefined && recheck?.(target.repo, target.pr, target.sha)) return true;
    if (await movedPast(headNow, target)) return true;
    await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}

/** A target with no sha merges whatever the head is, so no push moves past it. */
async function movedPast(headNow: OpenHeadRead, { repo, pr, sha }: MergeTarget): Promise<boolean> {
  if (sha === undefined) return false;
  const head = await headNow(repo, pr).catch(() => undefined);
  return head !== undefined && head !== sha;
}
