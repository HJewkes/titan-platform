import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import type { CleanupPorts } from "./cleanup.js";
import type { ShepherdStoreRef } from "./store.js";

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

export type WakeOutcome = { kind: "woken"; agent: string; sessionId?: string } | { kind: "unhandled"; reason: string };

export type ReviewRequest = PhaseTarget;

export type Verdict =
  | { kind: "MERGE"; headSha: string; evidence: unknown }
  | { kind: "FIX_FIRST"; headSha: string; text: string }
  | { kind: "NO_REPRO"; headSha: string; result: unknown }
  /** `noVerdict` says why no dispatched reviewer gave a verdict; absent means none was dispatched. */
  | { kind: "none"; noVerdict?: string };

/** A `none` verdict or `unhandled` wake leaves the decision to the owner gate. */
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
  /** Absent means `sh-cleanup` deletes the head ref only, and leaves the task and the agents alone. */
  cleanup?: CleanupPorts;
}
