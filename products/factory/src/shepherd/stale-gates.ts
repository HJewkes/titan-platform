import { GATE_CANCELLED_SIGNAL, type AssistedOptions, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import type { ZodType } from "zod";
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

/** Undefined means the head sweep cancelled the gate because the pull request moved past the head it asks about. */
async function askAtHead(ctx: WorkflowContext, prompt: string, options: AssistedOptions = {}): Promise<StepResult | undefined> {
  const answer = await ctx.assisted("approve-merge", prompt, { ...options, recordCancel: true });
  return answer.signal === GATE_CANCELLED_SIGNAL ? undefined : answer;
}

/** The parsed answer, or undefined when the head sweep cancelled the gate. */
export async function answerAtHead<T>(ctx: WorkflowContext, prompt: string, schema: ZodType<T>): Promise<T | undefined> {
  const asked = await askAtHead(ctx, prompt, { schema });
  return asked && schema.parse(asked.data);
}

/** An approve-merge gate the head sweep cancelled throws `leave()`, so the caller re-reads the pull request's head. */
export function supersedingGates(ctx: WorkflowContext, leave: () => Error): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    if (!stepIdMatches("approve-merge", stepId)) return ctx.assisted(stepId, prompt, options);
    const answer = await askAtHead(ctx, prompt, options);
    if (answer) return answer;
    throw leave();
  };
}
