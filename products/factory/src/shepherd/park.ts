import { BrokerUnavailableError, parkAgent } from "@titan-design/agent-dispatch";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { redactForEvidence } from "../redact.js";
import type { StepRoute } from "../routed-runner.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";
import type { ShepherdStoreRef } from "./store.js";

export const PARK_STEP = "sh-park";
export const PARK_STEPS: readonly StepDeclaration[] = [{ id: PARK_STEP, kind: "dispatch" }];

/** Parks the named agent's worktree and keeps its branch; throws when the broker refuses or cannot be reached. */
export type ParkPort = (name: string) => { lines: string[] };

export type ParkOutcome =
  | { kind: "parked"; agent: string; lines: string[] }
  | { kind: "not-parked"; agent: string; reason: string; brokerDown: boolean }
  | { kind: "skipped"; reason: string };

interface ParkInput {
  runId: string;
  headSha: string;
}

/** A refusal is an answer, not a failure: the tree stays and the run moves on to review. */
export function parkImplementer(store: ShepherdStoreRef, park: ParkPort, input: ParkInput): ParkOutcome {
  const agent = store.get().byRun(input.runId)?.implementer;
  if (!agent) return { kind: "skipped", reason: "no registration names the implementer" };
  try {
    return { kind: "parked", agent, lines: park(agent).lines };
  } catch (error) {
    const reason = redactForEvidence(error instanceof Error ? error.message : String(error));
    return { kind: "not-parked", agent, reason, brokerDown: error instanceof BrokerUnavailableError };
  }
}

export const parkRoutes = (deps: ShepherdDeps, park: ParkPort = (name) => parkAgent(deps.agentChatBin, name)): readonly StepRoute[] => [
  codeRoute(PARK_STEP, deps.now, async (input: ParkInput) => parkImplementer(deps.store, park, input)),
];

const ParkOutcomeResult = z.looseObject({ kind: z.enum(["parked", "not-parked", "skipped"]) });

/** Once per green head, before its review: a fix round's resume re-creates the tree, so the next green head parks it again. */
export async function parkAtGreen(ctx: WorkflowContext, headSha: string): Promise<void> {
  await step(ctx, `${PARK_STEP}:${headSha}`, { runId: ctx.runId, headSha }, ParkOutcomeResult);
}
