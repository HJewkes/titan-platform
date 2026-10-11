import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import type { CleanupPorts } from "./cleanup.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { RemoveDir } from "./review-checkout.js";
import type { ReviewCause } from "./review-schemas.js";
import type { RosterReader } from "./roster.js";
import type { SpawnGate } from "./spawn-gate.js";
import type { AccountLimitStoreRef } from "./account-store.js";
import type { ShepherdStoreRef } from "./store.js";
import type { SuiteRules } from "./suite-host.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";

/** Which PR, which head, and which land round a phase acts for. */
export interface PhaseTarget {
  repo: RepoSlug;
  pr: number;
  round: number;
  headSha: string;
}

export interface WakeRequest extends PhaseTarget {
  kind: "ci-red" | "review" | "conflict" | "fix-proof";
  payload: unknown;
}

/** How a wake reached the agent that later exited: the evidence its seat notice and recorded reason are built from. */
export interface WakeEvidence {
  agent: string;
  sessionId?: string;
  mode?: "resume" | "successor" | "live";
  /** Epoch milliseconds of the ask that the agent's turn was confirmed after; absent on a wake recorded before it existed. */
  askedAt?: number;
  fallback?: "resume" | "message";
}

export type WakeOutcome =
  | { kind: "woken"; agent: string; sessionId?: string; /** The head did not move: a rerun turned it green, so a later wake at it is a real one. */ sameHead?: true }
  | { kind: "unhandled"; reason: string; /** The woken agent exited with the head unchanged and the PR open. */ exited?: true; wake?: WakeEvidence };

export interface ReviewRequest extends PhaseTarget {
  /** Spawn a reviewer under a never-held name, so a reviewer that went silent at this head is not asked again. */
  fresh?: boolean;
  /** Why this head is reviewed; the intent step records it. */
  cause?: ReviewCause;
}

/**
 * Why a review gave no verdict: a refusal or silence, the wait ran out, the hold's reviewer has not answered, a busy broker
 * started nobody, or the reviewer's Claude account is out of usage.
 */
export type NoVerdictCause = "no-verdict" | "timeout" | "external-hold" | "not-started" | "account-exhausted";

export type Verdict =
  | { kind: "MERGE"; headSha: string; evidence: unknown; /** The profile Shepherd spawned the reviewer with; absent for an external, resumed or carried verdict. */ reviewerProfile?: string; /** The reviewed head this MERGE was carried from across a clean merge-up of the base. */ mergeUpFrom?: string }
  | { kind: "FIX_FIRST"; headSha: string; text: string; closer?: "yes" | "no" }
  | { kind: "NO_REPRO"; headSha: string; result: unknown }
  | { kind: "none"; cause?: NoVerdictCause; reason?: string };

/** The route table decides what a `none` verdict or an `unhandled` wake leads to. */
export interface ShepherdPhases {
  wake(ctx: WorkflowContext, request: WakeRequest): Promise<WakeOutcome>;
  review(ctx: WorkflowContext, request: ReviewRequest): Promise<Verdict>;
}

/** What a phase's routes may need; a phase takes only what it reads. */
export interface ShepherdDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  agentChatBin: string;
  /** The Claude config directory a successor spawns under; absent means agent-chat's default account. */
  agentChatConfigDir?: string;
  /** The serve process's one roster reader over `agentChatBin`; absent means each wake reads through its own. */
  roster?: RosterReader;
  /** Admits a successor spawn; absent means it is not gated. */
  spawnGate?: SpawnGate;
  /** Absent means `sh-cleanup` deletes the head ref only, and leaves the task and the agents alone. */
  cleanup?: CleanupPorts;
  /** The per-repo PR snapshot `sh-observe` reads; absent means it reads the port. */
  snapshot?: PrSnapshot;
  /** The App-token port `sh-publish-review` posts `shepherd/review` through; absent means it records `published: false`. */
  reviewCheck?: GitHubPort;
  /** Which reviewer accounts are out of usage; absent reads as a store that cannot be read, so a usage limit fails closed. */
  accountLimits?: AccountLimitStoreRef;
  /** Tells the repo's seat that a woken fixer exited with no push; absent means every such exit opens the owner gate. */
  exitNotice?: ExitNoticePorts;
  /** The test rules briefs carry, resolved once at serve start from its host; absent means the form for agents off basement. */
  suiteRules?: SuiteRules;
  /** Where reviewers extract checkouts and how a run's dir is removed; absent means the app data dir and `rm -rf`. */
  reviewCheckouts?: { root?: string; remove?: RemoveDir };
}
