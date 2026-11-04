import { z } from "zod";
import type { RoutedStepInput, StepRoute } from "./routed-runner.js";
import type { StepUsage, WorkflowContext } from "./types.js";

const INPUT_VAR = "CODE_STEP_INPUT";
const TEMPLATE = `{{${INPUT_VAR}}}`;

/** Turns a body's record into what the step stores; a host adds its evidence keys (kind, time, trace ids) here. */
export type CodeStepEnvelope = (record: object, step: RoutedStepInput) => object;

export interface CodeRouteOptions {
  /** Absent stores the record as the body returned it. */
  envelope?: CodeStepEnvelope;
  /** Rewrites a thrown message before the runtime records it, so a secret in an error never reaches the store. */
  errorText?: (message: string) => string;
}

/** Code steps take their input as JSON and answer with one record whose `result` the workflow reads. */
export async function codeStep<R>(ctx: WorkflowContext, stepId: string, input: object, result: z.ZodType<R>): Promise<R> {
  const done = await ctx.dispatch(stepId, TEMPLATE, { vars: { [INPUT_VAR]: JSON.stringify(input) }, schema: z.looseObject({ result }) });
  return done.data!.result;
}

/** The route for a `codeStep`: the body's answer is stored as the record's `result`. */
export function codeRoute<I>(match: string, fn: (input: I, step: RoutedStepInput) => Promise<unknown>, options: CodeRouteOptions = {}): StepRoute {
  return codeRecordRoute(match, async (input: I, step) => ({ result: await fn(input, step) }), options);
}

/** A record body's answer; `usage` is what a model call inside the body cost, and is kept off the stored record. */
export type CodeRecord = object & { usage?: StepUsage };

/** Thrown by a code step's body that spent money before it failed, so the failed step still reports that spend. */
export class CodeStepFailure extends Error {
  constructor(
    message: string,
    readonly usage: StepUsage,
  ) {
    super(message);
    this.name = "CodeStepFailure";
  }
}

/**
 * Like `codeRoute`, for a body that returns the whole record: `result` plus trace keys beside it, and optionally
 * `usage`, which becomes the step's usage so a model call made in code is summed like a dispatch's.
 * Every code step reads before it writes, so a crash repeats it and a throw is never retried.
 */
export function codeRecordRoute<I>(match: string, fn: (input: I, step: RoutedStepInput) => Promise<CodeRecord>, options: CodeRouteOptions = {}): StepRoute {
  const envelope = options.envelope ?? ((record: object) => record);
  const errorText = options.errorText ?? ((message: string) => message);
  const run = async (step: RoutedStepInput) => {
    try {
      const input: I = JSON.parse(step.prompt);
      const { usage, ...record } = await fn(input, step);
      return { ok: true as const, output: JSON.stringify(envelope(record, step)), ...(usage ? { usage } : {}) };
    } catch (error) {
      const usage = error instanceof CodeStepFailure ? { usage: error.usage } : {};
      return { ok: false as const, error: errorText(error instanceof Error ? error.message : String(error)), retryable: false, ...usage };
    }
  };
  return { match, onRestart: "repeat", runner: { run } };
}
