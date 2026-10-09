import type { MetricSpec } from "@titan-design/health/metrics";
import { mapItems, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { rankSlices } from "./classify.js";
import { auditStepId, MEASUREMENT_AUDIT_STEPS } from "./manifest.js";
import { buildReport, classifyAll, type AuditedMetric } from "./report.js";
import { reviewBrief } from "./review.js";
import * as S from "./schemas.js";

export const AUDIT_WORKFLOW = "measurement-audit";
const INPUT_VAR = "AUDIT_STEP_INPUT";
const BASELINE_CONCURRENCY = 4;

/** Every dispatch carries its input as JSON; the route's answer comes back under `result`, checked by `schema`. */
function dispatch<R>(ctx: WorkflowContext, stepId: string, input: object, schema: z.ZodType<R>): Promise<StepResult<{ result: R }>> {
  return ctx.dispatch(stepId, `{{${INPUT_VAR}}}`, { vars: { [INPUT_VAR]: JSON.stringify(input) }, schema: z.looseObject({ result: schema }) });
}

async function step<R>(ctx: WorkflowContext, stepId: string, input: object, schema: z.ZodType<R>): Promise<R> {
  return (await dispatch(ctx, stepId, input, schema)).data!.result;
}

/** `out` is required up front: publish runs after the review gate, often in a later `resume`, where nothing would print the report. */
function auditParams(ctx: WorkflowContext): { input: unknown; out: string } {
  const raw = ctx.param("input");
  const out = ctx.param("out");
  if (!raw) throw new Error(`${AUDIT_WORKFLOW}: param input is required`);
  if (!out) throw new Error(`${AUDIT_WORKFLOW}: param out is required`);
  return { input: JSON.parse(raw) as unknown, out };
}

/** Steps 1 to 5: what the system stores, emits, is for, and which of its questions the surfaces answer today. */
async function understand(ctx: WorkflowContext, input: unknown) {
  const loaded = await step(ctx, auditStepId("load"), { input }, S.LoadedSchema);
  const { system, codeRoots, stores, surfaces, owner, sources } = loaded.input;
  const data = await step(ctx, auditStepId("inventory-data"), { stores }, S.DataInventorySchema);
  const emitters = await step(ctx, auditStepId("inventory-code"), { system, codeRoots, data }, S.EmitterInventorySchema);
  const purpose = await step(ctx, auditStepId("purpose"), { system, owner, sources, surfaces, data, emitters }, S.PurposeSchema);
  const { checks } = await step(ctx, auditStepId("answerability"), { questions: purpose.questions, surfaces }, S.QuestionChecksSchema);
  return { loaded, data, emitters, purpose, checks };
}

/** Step 7: one item per metric, so a resumed run re-queries only the metrics it had not reached. */
async function baseline(ctx: WorkflowContext, metrics: readonly MetricSpec[], stores: readonly S.StoreRef[]): Promise<Map<string, S.Baseline>> {
  const run = (metric: MetricSpec) => dispatch(ctx, `${auditStepId("baseline")}:${metric.id}`, { query: metric.query, store: stores.find((store) => store.id === metric.query?.store) }, S.BaselineSchema);
  const mapped = await mapItems(ctx, auditStepId("baseline"), metrics, (metric) => run(metric), { key: (metric) => metric.id, concurrency: BASELINE_CONCURRENCY });
  const baselines = new Map(mapped.results.map(({ key, result }) => [key, (result.data as { result: S.Baseline }).result]));
  for (const { key, error } of mapped.failed) baselines.set(key, { value: null, n: 0, error });
  return baselines;
}

/** Steps 6 to 9: propose metrics, measure them, and turn what is missing into ranked slices and a surface plan. */
async function measure(ctx: WorkflowContext, found: Awaited<ReturnType<typeof understand>>) {
  const { system, stores } = found.loaded.input;
  const questions = found.checks.map((check) => check.question);
  const { metrics } = await step(ctx, auditStepId("propose"), { system, questions, data: found.data, emitters: found.emitters }, S.ProposalSchema);
  const audited = classifyAll(metrics, await baseline(ctx, metrics, stores));
  const missing = audited.filter((metric) => metric.source.captured !== "Y").map(gapView);
  const { slices } = await step(ctx, auditStepId("gaps"), { system, gaps: missing, questions }, S.GapProposalSchema);
  const { reports } = await step(ctx, auditStepId("plan"), { system, metrics: audited.map(gapView), questions }, S.SurfacePlanSchema);
  return { metrics: audited, gaps: rankSlices(system, slices, audited), reports };
}

const gapView = ({ id, family, title, definition, source, surfaces, answers }: AuditedMetric) => ({ id, family, title, definition, source, surfaces, answers });

/** Steps 10 and 11: the area owner reviews the counts and slices; only a publish writes the report. */
async function measurementAudit(ctx: WorkflowContext): Promise<void> {
  const { input, out } = auditParams(ctx);
  const found = await understand(ctx, input);
  const report = buildReport({ ...found, ...(await measure(ctx, found)) });
  const review = await ctx.assisted(auditStepId("review"), `Publish the ${report.system} measurement audit?`, { schema: S.ReviewAnswerSchema, brief: reviewBrief(report, ctx.runId) });
  if (S.ReviewAnswerSchema.parse(review.data).decision !== "publish") return;
  await step(ctx, auditStepId("publish"), { report, out }, S.PublishedSchema);
}

export function measurementAuditWorkflow(): WorkflowDefinition {
  return defineWorkflow({ name: AUDIT_WORKFLOW, steps: MEASUREMENT_AUDIT_STEPS, run: measurementAudit });
}
