import { GATE_CANCELLED_SIGNAL, type AssistedOptions, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";

const HEAD_GATES = /\/(approve-merge|sh-sent-back)(:\d+)?$/;
const HEAD_IN_PROMPT = /\bat head ([0-9a-f]{40})\b/;

/** The head a gate's prompt asks about, if it names one. */
export function gateHead(prompt: string): string | undefined {
  return HEAD_IN_PROMPT.exec(prompt)?.[1];
}

/** A cycle at a new head leaves no owner question about an older head open; a gate at this head stays. */
export function expireStaleGates(ctx: WorkflowContext, headSha: string): void {
  ctx.expireGates(`the run moved on to head ${headSha}`, (gate) => HEAD_GATES.test(gate.id) && ![undefined, headSha].includes(gateHead(gate.prompt)));
}

/** How the head sweep's cancel reason starts; any other cancel of a head gate still fails the run. */
export const SUPERSEDED = "superseded: ";

/** How a sweep cancel starts when the head stays and only its review must be taken again, so the facts are read afresh. */
export const REREVIEW = `${SUPERSEDED}review again: `;

type Superseded = { superseded: string };

async function answerOrSuperseded(ctx: WorkflowContext, stepId: string, prompt: string, options: AssistedOptions): Promise<StepResult | Superseded> {
  const answer = await ctx.assisted(stepId, prompt, { ...options, recordCancel: true });
  if (answer.signal !== GATE_CANCELLED_SIGNAL) return answer;
  const reason = String(answer.data?.reason);
  if (reason.startsWith(SUPERSEDED)) return { superseded: reason };
  throw new Error(`${stepId} was cancelled: ${reason}`);
}

/** Undefined means the head sweep cancelled the gate because the pull request moved past the head it asks about. */
export async function askAtHead(ctx: WorkflowContext, stepId: string, prompt: string, options: AssistedOptions = {}): Promise<StepResult | undefined> {
  const answer = await answerOrSuperseded(ctx, stepId, prompt, options);
  return "superseded" in answer ? undefined : answer;
}

/** An approve-merge gate the head sweep cancelled throws `leave()`, so the caller re-reads the head; `rereview` names a head to review again. */
export function supersedingGates(ctx: WorkflowContext, leave: (rereview?: string) => Error): WorkflowContext["assisted"] {
  return async (stepId, prompt, options = {}) => {
    if (!stepIdMatches("approve-merge", stepId)) return ctx.assisted(stepId, prompt, options);
    const answer = await answerOrSuperseded(ctx, stepId, prompt, options);
    if (!("superseded" in answer)) return answer;
    throw leave(answer.superseded.startsWith(REREVIEW) ? gateHead(prompt) : undefined);
  };
}
