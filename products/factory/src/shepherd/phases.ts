import type { WorkflowContext } from "@titan-design/workflow";

export interface WakeRequest {
  kind: "ci-red" | "review" | "conflict";
  headSha: string;
  payload: unknown;
}

export type WakeOutcome = { kind: "woken"; agent: string; sessionId?: string } | { kind: "unhandled"; reason: string };

export interface ReviewRequest {
  headSha: string;
}

export type Verdict =
  | { kind: "MERGE"; headSha: string; evidence: unknown }
  | { kind: "FIX_FIRST"; headSha: string; text: string }
  | { kind: "none" };

/** A `none` verdict or `unhandled` wake leaves the decision to the owner gate. */
export interface ShepherdPhases {
  wake(ctx: WorkflowContext, request: WakeRequest): Promise<WakeOutcome>;
  review(ctx: WorkflowContext, request: ReviewRequest): Promise<Verdict>;
}
