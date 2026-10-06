import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { parseVerdictBlock } from "@titan-design/session-read";
import { redactForEvidence } from "../redact.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute } from "../workflows/land.js";
import { acceptExternalVerdict, externalReviewer, latestSession } from "./external-review.js";
import type { FreezeGuard } from "./freeze.js";
import { provablyIndependent, type ReviewerAgent, type ReviewerMessage, type ReviewerReader } from "./review.js";
import type { HoldLookup, Registration, ShepherdStore } from "./store.js";
import { namesPr } from "./verdict-target.js";
import type { CarryInput, CarryResult } from "./tree-carry.js";
import { CARRYING_KINDS } from "./carry-merge.js";

export const HOLD_POLL_MS = 10_000;

export class MergeHeldError extends Error {
  override readonly name = "MergeHeldError";
}

/**
 * Why a merge of `repo#pr` at `sha` must wait, read fresh; a PR merged or closed elsewhere has nothing left to wait for; any
 * other state, unknown included, keeps the hold. A hold satisfied at `sha` passes only while `sha` is still the head; no
 * `sha` means the head as read now.
 */
export type HeldCheck = (repo: RepoSlug, pr: number, sha?: string) => Promise<string | undefined>;

/** Reads the hold's named reviewer at `sha` and records the newest verdict there: MERGE satisfies the hold, FIX_FIRST withdraws it. */
export type HoldSatisfier = (repo: RepoSlug, pr: number, sha: string, baseRef: string) => Promise<void>;

export interface HoldSatisfierDeps {
  store: () => ShepherdStore;
  roster: () => Promise<readonly ReviewerAgent[]>;
  reader: ReviewerReader;
  /** The `sh-carry` probe; absent means a satisfaction never moves to another head. */
  carry?: (input: CarryInput) => Promise<CarryResult>;
}

/** A read that fails, a reviewer not on the roster, or one not provably independent of the code's authors changes nothing. */
export function holdSatisfier(deps: HoldSatisfierDeps): HoldSatisfier {
  return async (repo, pr, sha, baseRef) => {
    const store = deps.store();
    const registration = store.byPr(repo, pr);
    const reviewer = externalReviewer(registration);
    if (registration === undefined || reviewer === undefined) return;
    const roster = await deps.roster().catch((): readonly ReviewerAgent[] => []);
    const row = latestSession(reviewer, roster);
    if (row === undefined || !independent(row, registration, roster, store)) return;
    const read = { repo, pr, head: sha, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
    const messages = await deps.reader.read(read).catch(() => []);
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

/** The newest verdict block on this PR in any session under the reviewer's name, at any head, so a FIX_FIRST at a head nobody asked about still stops a carry past it; on a tie in time a FIX_FIRST or WAIT wins; a WAIT stops a carry without unsatisfying. */
async function newestOwn(reader: ReviewerReader, rows: readonly ReviewerAgent[], repo: RepoSlug, pr: number): Promise<"MERGE" | "FIX_FIRST" | "WAIT" | undefined> {
  let newest: { at: number; verdict: "MERGE" | "FIX_FIRST" | "WAIT" } | undefined;
  for (const row of rows) {
    const messages = await reader.read({ repo, pr, head: "", reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 }).catch((): readonly ReviewerMessage[] => []);
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

/** The roster's lineage must clear the reviewer, and so must the run's recorded authors, by agent id and by name. */
function independent(row: ReviewerAgent, registration: Registration, roster: readonly ReviewerAgent[], store: ShepherdStore): boolean {
  const authors = store.authorsOf(registration.runId);
  if (authors.some((author) => author.agentId === row.agentId || author.name === row.name)) return false;
  return provablyIndependent(row, registration.implementer, roster);
}

/** The first guard that names a reason decides; later guards are not read. */
export function firstReason(...guards: readonly FreezeGuard[]): FreezeGuard {
  return {
    async reason(port, repo, pr, baseRef) {
      for (const guard of guards) {
        const reason = await guard.reason(port, repo, pr, baseRef);
        if (reason !== undefined) return reason;
      }
      return undefined;
    },
  };
}

export function heldCheck(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard, satisfy?: HoldSatisfier): HeldCheck {
  return async (repo, pr, sha) => {
    const lookup = holds();
    const { headRef, baseRef, state, merged, headSha } = await port.getPr(repo, pr);
    if (merged || state === "closed") return undefined;
    const at = sha === undefined || sha === headSha ? headSha : undefined;
    if (at !== undefined) await satisfy?.(repo, pr, at, baseRef);
    return lookup.heldReason(repo, pr, headRef, at) ?? (await freeze?.reason(port, repo, pr, baseRef));
  };
}

/** The port handed to `landRoutes`: its merge refuses a held PR, and any PR of a frozen repo but the fix task's; any other PR passes straight through. */
export function holdingPort(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard, satisfy?: HoldSatisfier): GitHubPort {
  const held = heldCheck(port, holds, freeze, satisfy);
  return {
    ...port,
    merge: async (repo, pr, sha, method) => {
      const reason = await held(repo, pr, sha);
      if (reason !== undefined) throw new MergeHeldError(`${repo}#${pr} is held: ${reason}`);
      return port.merge(repo, pr, sha, method);
    },
  };
}

export interface HoldTiming {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  now?: () => number;
}

/** What the merge step answers after a wait: no merge, so land reads CI again, since the base may have moved while it was held. */
const AFTER_HOLD = { done: false, skipped: "held", mergeSha: "" };

/** Wraps the `merge` route so a held PR waits for release, abort-safe, instead of failing on the port's refusal. */
export function waitWhileHeld(route: StepRoute, held: HeldCheck, timing: HoldTiming): StepRoute {
  const afterHold = codeRoute(route.match, timing.now ?? Date.now, async () => AFTER_HOLD);
  return {
    ...route,
    runner: {
      run: async (input) => {
        let waited: boolean;
        try {
          waited = await untilReleased(held, JSON.parse(input.prompt) as MergeTarget, input.signal, timing);
        } catch (error) {
          return { ok: false, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
        }
        return (waited ? afterHold : route).runner.run(input);
      },
    },
  };
}

interface MergeTarget {
  repo: RepoSlug;
  pr: number;
  sha: string;
}

/**
 * True when the PR was held at least once before its release. A head that moved on past `sha` stays held at `sha`
 * forever, so a hold its reviewer satisfied at the new head ends the wait too: land then reads CI at that head.
 */
async function untilReleased(held: HeldCheck, target: MergeTarget, signal: AbortSignal, timing: HoldTiming): Promise<boolean> {
  for (let waited = false; ; waited = true) {
    signal.throwIfAborted();
    if ((await held(target.repo, target.pr, target.sha)) === undefined) return waited;
    if ((await held(target.repo, target.pr)) === undefined) return true;
    await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}
