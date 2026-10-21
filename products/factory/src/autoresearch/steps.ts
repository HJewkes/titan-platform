import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";

const INPUT_VAR = "AR_STEP_INPUT";

/** Every dispatch carries its input as JSON; the route's answer comes back under `result`, checked by `schema`. */
export function dispatch<R>(ctx: WorkflowContext, stepId: string, input: object, schema: z.ZodType<R>): Promise<StepResult<{ result: R }>> {
  return ctx.dispatch(stepId, `{{${INPUT_VAR}}}`, { vars: { [INPUT_VAR]: JSON.stringify(input) }, schema: z.looseObject({ result: schema }) });
}

export async function step<R>(ctx: WorkflowContext, stepId: string, input: object, schema: z.ZodType<R>): Promise<R> {
  return (await dispatch(ctx, stepId, input, schema)).data!.result;
}

/** A pure decision recorded once, so a replay reads it back rather than recomputing it under newer code. */
export async function recorded<T>(ctx: WorkflowContext, stepId: string, schema: z.ZodType<T>, decide: () => T): Promise<T> {
  const result = await ctx.seed(stepId, async () => ({ data: {}, output: JSON.stringify(decide()) }));
  return schema.parse(JSON.parse(result.output!));
}
