import type { WorkflowContext } from "@titan-design/workflow";

const HEAD_GATES = /\/(approve-merge|sh-sent-back)(:\d+)?$/;
const HEAD_IN_PROMPT = /\bat head ([0-9a-f]{40})\b/;

/** A cycle at a new head leaves no owner question about an older head open; a gate at this head stays. */
export function expireStaleGates(ctx: WorkflowContext, headSha: string): void {
  const askedAbout = (prompt: string) => HEAD_IN_PROMPT.exec(prompt)?.[1];
  ctx.expireGates(`the run moved on to head ${headSha}`, (gate) => HEAD_GATES.test(gate.id) && ![undefined, headSha].includes(askedAbout(gate.prompt)));
}
