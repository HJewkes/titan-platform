import type { AgentIdentity } from "@titan-design/authority";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { OwnerBrief, ReviewShape } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import type { CleanupPorts, TaskClose } from "./cleanup.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { FixFirstEntry, FixRound } from "./fix-first-trail.js";
import type { RemoveDir } from "./review-checkout.js";
import type { ReviewCause } from "./review-schemas.js";
import type { RosterReader } from "./roster.js";
import type { SpawnGate } from "./spawn-gate.js";
import type { AccountLimitStoreRef } from "./account-store.js";
import type { ShepherdStoreRef } from "./store.js";
import type { SuiteRules } from "./suite-host.js";
import type { PrFilesRead } from "./git-pr-files.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import type { PushWatch } from "./push-signal.js";
import type { VisualPacketPorts } from "./visual-packet-trigger.js";
import type { DiagnosisPorts } from "./no-verdict-diagnosis.js";

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
  /** Shepherd's own MERGE at this head that a seat held last round; only the seat check runs again. */
  seatHeld?: SeatHeld;
  /** The run's FIX_FIRST trail, set only on D8's convergence review of a runaway head (TP-3734). */
  convergence?: readonly FixFirstEntry[];
  /** A fix round after a reviewer's FIX_FIRST, which `shepherd.review.scopedRereview` may scope to the fix diff (TP-3735). */
  fixRound?: FixRound;
}

/**
 * Why a review gave no verdict: a refusal or silence, the wait ran out, the hold's reviewer has not answered, a busy broker
 * started nobody, the reviewer's Claude account is out of usage, the reviewer went silent while the machine stop held, or
 * preflight found a hard error, such as a member planned onto an uninstalled profile, before any reviewer started.
 */
export type NoVerdictCause = "no-verdict" | "timeout" | "external-hold" | "not-started" | "account-exhausted" | "throttled" | "needs-fixer";

/** What a panel MERGE records beside the correctness member's verdict: each member that gave one, and whether the panel met G10. */
export interface PanelMerge {
  satisfiesG10: boolean;
  degraded: readonly ReviewShape[];
  members: readonly PanelMember[];
}

/** One member's verdict; `verdict`, `head` and `profile` are absent on a MERGE recorded before the two-MERGE release read them. */
export interface PanelMember {
  shape: ReviewShape;
  agentId: string;
  sessionId: string;
  locator: unknown;
  verdict?: "MERGE" | "FIX_FIRST";
  head?: string;
  /** The profile Shepherd spawned the member at. */
  profile?: string;
}

/** Shepherd's own MERGE at `head` that a seat reviewer's WAIT, or a seat read that can clear, still held when the seat wait ran out. */
export interface SeatHeld {
  head: string;
  locator: unknown;
  reviewer: AgentIdentity;
  dispatchedReviewer: AgentIdentity;
  /** The verdict step's MERGE as recorded, which the next round's seat recheck holds or lets stand. */
  merge: Readonly<Record<string, unknown>>;
}

export type Verdict =
  | { kind: "MERGE"; /** Set only when `review.panel` is `on` and the head's intent recorded a plan. */ panel?: PanelMerge; headSha: string; evidence: unknown; /** The profile Shepherd spawned the reviewer with; absent for an external, resumed or carried verdict. */ reviewerProfile?: string; /** The reviewed head this MERGE was carried from across a clean merge-up of the base. */ mergeUpFrom?: string; /** The reviewer's OWNER-BRIEF block, shown on an approve-merge gate at this head. */ ownerBrief?: OwnerBrief }
  | { kind: "FIX_FIRST"; headSha: string; text: string; closer?: "yes" | "no" }
  | { kind: "NO_REPRO"; headSha: string; result: unknown }
  | { kind: "none"; cause?: NoVerdictCause; reason?: string; seatHeld?: SeatHeld };

/** `shepherd.visualSetCarry`: whether a red head failing only its seat's baseline check asks the owner to accept CI's set. */
export type VisualSetCarry = "off" | "shadow" | "on";

/** The route table decides what a `none` verdict or an `unhandled` wake leads to. */
export interface ShepherdPhases {
  wake(ctx: WorkflowContext, request: WakeRequest): Promise<WakeOutcome>;
  review(ctx: WorkflowContext, request: ReviewRequest): Promise<Verdict>;
  /** Read only where the run is live, never on replay; absent means `off`. */
  visualSetCarry?: () => VisualSetCarry;
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
  /** The accounts a successor may spawn under, preferred first, read per wake; the first with headroom wins. Absent means `agentChatConfigDir`. */
  successorAccounts?: () => readonly string[];
  /** The serve process's one roster reader over `agentChatBin`; absent means each wake reads through its own. */
  roster?: RosterReader;
  /** Admits a successor spawn; absent means it is not gated. */
  spawnGate?: SpawnGate;
  /** Absent means `sh-cleanup` deletes the head ref only, and leaves the task and the agents alone. */
  cleanup?: CleanupPorts;
  /** The per-repo PR snapshot `sh-observe` reads; absent means it reads the port. */
  snapshot?: PrSnapshot;
  /** The seat clones' push reflogs a head wait watches; absent means it reads the PR once per backstop. */
  pushes?: PushWatch;
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
  /** True for a repo where Shepherd never writes to a branch: no successor is spawned and no head ref deleted. */
  advisory?: (repo: string) => boolean;
  /** Reads a head's changed files from Shepherd's git cache; absent means the serve process's cached reader. */
  prFiles?: PrFilesRead;
  /** Repos whose stacked children Shepherd restacks after its own merge; absent means none. */
  stackRestack?: (repo: RepoSlug) => boolean;
  /** `on` repairs a run held only under a g10 class while the hold keeps gating its merge; absent means `off`. */
  heldRepair?: "off" | "on";
  /** `on` lets a vacuous fix-proof on a test-only PR with a tests-only diff proceed to review; absent means `off`. */
  noReproProceed?: "off" | "on";
  /** `record-fact` sends a NO_REPRO on a diff with no source path on to review, recorded on the run (TP-4275); absent means `keep-owner`. */
  nonSourceNoRepro?: "keep-owner" | "record-fact";
  /** `last-slice-only` closes a merged PR's task only on its last slice; absent means `keep`. */
  taskClose?: TaskClose;
  /** `shepherd.visualPacket`: whether a visual approve-merge gate spawns its review packager; absent means `off`. */
  visualPacket?: VisualPacketPorts;
  /** The planner failed rounds with no adversary verdict spawn (TP-3796); absent records a failed spawn, so ops hears instead. */
  diagnosis?: DiagnosisPorts;
  /** `shepherd.consoleAnswers` is configured, so each approve-merge gate offers the owner `send-back`; absent means none does. */
  consoleAnswers?: boolean;
  /** The name of the repo seat's `visualBaselines.check`; absent, or undefined for a repo, means no red head is offered for acceptance. */
  visualBaselineCheck?: (repo: string) => string | undefined;
}
