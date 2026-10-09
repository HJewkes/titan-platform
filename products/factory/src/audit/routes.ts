import { createHash } from "node:crypto";
import type { RoutedStepInput, StepRoute } from "@titan-design/workflow";
import type { ZodType } from "zod";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";
import { isDeclaredSurface } from "./classify.js";
import { auditStepId, manifestStep, type AgentStepName } from "./manifest.js";
import type { AuditPorts } from "./ports.js";
import { agentPrompt } from "./prompts.js";
import * as S from "./schemas.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every audit step only reads (publish rewrites the same file), so each is safe to repeat after a crash. */
function auditRoute<I>(match: string, now: () => number, fn: (input: I, signal: AbortSignal) => Promise<object>): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const result = await fn(JSON.parse(step.prompt) as I, step.signal);
      return { ok: true as const, output: JSON.stringify(evidenceRecord(`audit.${match}`, step, new Date(now()).toISOString(), { result })) };
    } catch (error) {
      return { ok: false as const, error: redactForEvidence(messageOf(error)), retryable: false };
    }
  };
  return { match, onRestart: "repeat", runner: { run } };
}

function agentRoute(ports: AuditPorts, step: AgentStepName, schema: ZodType): StepRoute {
  const model = manifestStep(step).model!;
  return auditRoute(auditStepId(step), ports.now, async (input: unknown, signal) => schema.parse(await ports.agent({ step, model, prompt: agentPrompt(step, input), schema, signal })) as object);
}

async function load(ports: AuditPorts, raw: unknown): Promise<S.Loaded> {
  const parsed = S.AuditInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`audit input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const input = parsed.data;
  if (input.mode === "reaudit") throw new Error("a reaudit needs the drift check, which has not landed; run mode initial");
  if (!(await ports.areas()).includes(input.system)) throw new Error(`area "${input.system}" is not in the area registry`);
  return { input, prior: await ports.prior(input.system), codeRev: await ports.codeRev(), at: new Date(ports.now()).toISOString() };
}

/** Only a declared surface is run; a claim whose command fails there is not answerable now. */
async function checkQuestion(ports: AuditPorts, question: S.Question, surfaces: readonly S.SurfaceRef[], signal: AbortSignal): Promise<S.QuestionCheck> {
  if (!question.command || question.answerable === "no" || !isDeclaredSurface(question.command, surfaces)) return { question };
  try {
    const output = await ports.surface(question.command, signal);
    return { question, outputHash: createHash("sha256").update(output).digest("hex") };
  } catch (error) {
    return { question: { ...question, answerable: "no" }, error: messageOf(error) };
  }
}

async function checkQuestions(ports: AuditPorts, input: { questions: S.Question[]; surfaces: S.SurfaceRef[] }, signal: AbortSignal) {
  const checks: S.QuestionCheck[] = [];
  for (const question of input.questions) checks.push(await checkQuestion(ports, question, input.surfaces, signal));
  return { checks };
}

/** A failed or missing query is recorded as an error with no value; it is never a zero. */
async function measureOne(ports: AuditPorts, input: { query?: S.MetricQuery; store?: S.StoreRef }, signal: AbortSignal): Promise<S.Baseline> {
  if (!input.query) return { value: null, n: 0, error: "no query" };
  if (!input.store) return { value: null, n: 0, error: `store "${input.query.store}" is not in the audit input` };
  try {
    return await ports.query(input.store, input.query, signal);
  } catch (error) {
    return { value: null, n: 0, error: messageOf(error) };
  }
}

async function publish(ports: AuditPorts, input: { report: unknown; out: string }) {
  await ports.writeReport(input.out, `${JSON.stringify(input.report, null, 2)}\n`);
  return { path: input.out, report: input.report };
}

export function auditRoutes(ports: AuditPorts): StepRoute[] {
  const now = ports.now;
  return [
    auditRoute(auditStepId("load"), now, (input: { input: unknown }) => load(ports, input.input)),
    auditRoute(auditStepId("inventory-data"), now, async (input: { stores: S.StoreRef[] }, signal) => ({ stores: await Promise.all(input.stores.map((store) => ports.inventory(store, signal))) })),
    agentRoute(ports, "inventory-code", S.EmitterInventorySchema),
    agentRoute(ports, "purpose", S.PurposeSchema),
    auditRoute(auditStepId("answerability"), now, (input: { questions: S.Question[]; surfaces: S.SurfaceRef[] }, signal) => checkQuestions(ports, input, signal)),
    agentRoute(ports, "propose", S.ProposalSchema),
    auditRoute(auditStepId("baseline"), now, (input: { query?: S.MetricQuery; store?: S.StoreRef }, signal) => measureOne(ports, input, signal)),
    agentRoute(ports, "gaps", S.GapProposalSchema),
    agentRoute(ports, "plan", S.SurfacePlanSchema),
    auditRoute(auditStepId("publish"), now, (input: { report: unknown; out: string }) => publish(ports, input)),
  ];
}
