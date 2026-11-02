import { codeRoute, codeStep, routedRunner, WorkflowRuntime, type StepRoute, type WorkflowContext, type WorkflowFn, type WorkflowRun, type WorkflowRuntimeOptions } from "@titan-design/workflow";
import { z } from "zod";
import { REVIEW_STEP_BODIES, type ReviewBodyPorts } from "./bodies.js";
import { resolveFingerprint, type Resumed } from "./fixer.js";
import { reviewHead, type ReviewHeadPolicy, type ReviewHost } from "./recipe.js";
import { DEFAULT_REVIEW_STEP_IDS, type ReviewHeadInput, type ReviewOutcome, type ReviewStepIds } from "./types.js";

export const REVIEW_WORKFLOW_NAME = "review-head";
/** Bump it whenever a recorded run would replay differently; hydrate then parks a run pinned to the old one as recovery_required. */
export const REVIEW_WORKFLOW_VERSION = "1";

const INPUT_PARAM = "review-input";
const OUTCOME_PARAM = "review-outcome";

/** What a caller asks a review of; the run id is the workflow run's own. */
export type ReviewRequestInput = Omit<ReviewHeadInput, "runId">;

/** Checked on the fields the recipe reads first; the rest is the caller's own request, as a step record is. */
const RequestSchema = z.custom<ReviewRequestInput>((value) => z.looseObject({ target: z.looseObject({ head: z.string() }), brief: z.looseObject({}) }).safeParse(value).success);
const OutcomeSchema = z.custom<ReviewOutcome>((value) => z.looseObject({ kind: z.string(), head: z.string() }).safeParse(value).success);

export interface ReviewWorkflowOptions {
  ports: ReviewBodyPorts;
  policy: ReviewHeadPolicy;
  ids?: Partial<ReviewStepIds>;
  /** Absent means `REVIEW_WORKFLOW_VERSION`. */
  version?: string;
}

/** A definition a host registers with `register(name, run, { version })` and runs over `routedRunner(routes)`. */
export interface ReviewWorkflow {
  name: string;
  version: string;
  run: WorkflowFn;
  routes: StepRoute[];
}

/** One inline code route per step body, under the ids the recipe records; every body reads before it writes, so a restart repeats it. */
export function reviewRoutes(ports: ReviewBodyPorts, ids: Partial<ReviewStepIds> = {}): StepRoute[] {
  const id = { ...DEFAULT_REVIEW_STEP_IDS, ...ids };
  const bodies = REVIEW_STEP_BODIES;
  type In<K extends keyof typeof bodies> = Parameters<(typeof bodies)[K]>[0];
  return [
    codeRoute(id.preflight, (body: In<"preflight">) => bodies.preflight(body, ports)),
    codeRoute(id.heal, (body: In<"heal">) => bodies.heal(body, ports)),
    codeRoute(id.intent, (body: In<"intent">) => bodies.intent(body)),
    codeRoute(id.dispatch, (body: In<"dispatch">, step) => bodies.dispatch(body, ports, step.signal)),
    codeRoute(id.await, (body: In<"await">, step) => bodies.await(body, ports, step.signal)),
    codeRoute(id.correct, (body: In<"correct">, step) => bodies.correct(body, ports, step.signal)),
    codeRoute(id.lateRead, (body: In<"lateRead">) => bodies.lateRead(body, ports)),
    codeRoute(id.aggregate, (body: In<"aggregate">) => bodies.aggregate(body, ports)),
    codeRoute(id.fixer, (body: In<"fixer">) => bodies.fixer(body, ports)),
  ];
}

function requestOf(runId: string, raw: string | undefined): ReviewRequestInput {
  if (raw === undefined) throw new Error(`review run ${runId} has no ${INPUT_PARAM} param`);
  return RequestSchema.parse(JSON.parse(raw));
}

function hostOf(ctx: WorkflowContext, ids: Partial<ReviewStepIds>): ReviewHost {
  return { call: (stepId, input, schema) => codeStep(ctx, stepId, input, schema), historyNext: () => ctx.historyNext(), ids };
}

/** The review as one workflow run: the recipe over code steps, its outcome seeded into the run's params. */
export function reviewWorkflow(options: ReviewWorkflowOptions): ReviewWorkflow {
  const ids = options.ids ?? {};
  const run: WorkflowFn = async (ctx) => {
    const input = { ...requestOf(ctx.runId, ctx.param(INPUT_PARAM)), runId: ctx.runId };
    const outcome = await reviewHead(hostOf(ctx, ids), input, options.policy);
    await ctx.seed(OUTCOME_PARAM, async () => ({ data: { [OUTCOME_PARAM]: JSON.stringify(outcome) } }));
  };
  return { name: REVIEW_WORKFLOW_NAME, version: options.version ?? REVIEW_WORKFLOW_VERSION, run, routes: reviewRoutes(options.ports, ids) };
}

/** The outcome a completed run seeded; any other end is thrown, since it has none. */
export function reviewOutcomeOf(run: WorkflowRun): ReviewOutcome {
  const raw = run.params[OUTCOME_PARAM];
  if (run.status !== "completed" || raw === undefined) throw new Error(`review run ${run.id} ended ${run.status}${run.error ? `: ${run.error}` : ""}`);
  return OutcomeSchema.parse(JSON.parse(raw));
}

export interface ReviewRunner {
  runtime: WorkflowRuntime;
  start(input: ReviewRequestInput): string;
  /** Waits for the run and returns its outcome; throws when it ended any way but completed. */
  outcome(runId: string): Promise<ReviewOutcome>;
  /** Resumes the runs a previous process left; a run pinned to another definition version parks instead. */
  hydrate(): Promise<string[]>;
  /** Reviews every run parked on the fingerprint again, each as a fresh run of its original request. */
  resolve(fingerprint: string): Promise<Resumed[]>;
}

/** The standalone host: a runtime over the review's inline routes, with the definition registered under its version. */
export function reviewRunner(options: ReviewWorkflowOptions & { runtime: Omit<WorkflowRuntimeOptions, "runner"> }): ReviewRunner {
  const workflow = reviewWorkflow(options);
  const runtime = new WorkflowRuntime({ ...options.runtime, runner: routedRunner(workflow.routes) });
  runtime.register(workflow.name, workflow.run, { version: workflow.version });
  const start = (input: ReviewRequestInput): string => runtime.start(workflow.name, { [INPUT_PARAM]: JSON.stringify(input) });
  const outcome = async (runId: string): Promise<ReviewOutcome> => reviewOutcomeOf(await runtime.wait(runId));
  const rerun = (runId: string): Promise<ReviewOutcome> => {
    const parked = runtime.status(runId);
    if (parked === undefined) throw new Error(`unknown review run: ${runId}`);
    return outcome(start(requestOf(runId, parked.params[INPUT_PARAM])));
  };
  return {
    runtime,
    start,
    outcome,
    hydrate: () => runtime.hydrate(),
    resolve: (fingerprint) => resolveFingerprint(options.ports.parking, fingerprint, async (parked) => rerun(parked.runId)),
  };
}
