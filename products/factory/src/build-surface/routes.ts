import { codeRecordRoute, type RoutedStepInput, type StepRoute } from "@titan-design/workflow";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";
import { DISPATCH_STEPS } from "./manifest.js";
import type { BuildSurfacePorts } from "./ports.js";
import { GateEvidenceSchema, ImplementerReportSchema, ReviewReportSchema, type GateRun, type LandState, type Validation } from "./schemas.js";
import { parseBuildSpec } from "./spec.js";
import type * as I from "./step-inputs.js";

const tail = (text: string): string => text.trim().split("\n").slice(-5).join(" | ").slice(0, 500);

/** Why a parked step's restart needs a human, said on the recovery the owner reads. */
const PARKED: Readonly<Record<string, string>> = {
  "bs-implement": "the slice implementer may still be working or mid-push; resume the run once its agent has exited; the resume starts a new implement turn with the full brief and takes only a report written after it",
  "bs-fix": "the fix round's implementer may still be working or mid-push; resume the run once its agent has exited",
  "bs-deploy": "the deploy command was interrupted and may have half-run; check the live surface before resuming",
};

/** Every step's answer is `{result}` inside an evidence record; a thrown error fails the step without a retry. */
function bsRoute<I>(match: string, ports: Pick<BuildSurfacePorts, "now">, fn: (input: I, signal: AbortSignal) => Promise<object & { costUsd?: number }>): StepRoute {
  const envelope = (record: object, step: RoutedStepInput) => evidenceRecord(`build-surface.${match}`, step, new Date(ports.now()).toISOString(), record);
  const route = codeRecordRoute(match, async (input: I, step) => {
    const result = await fn(input, step.signal);
    return { result, ...(result.costUsd !== undefined && { usage: { costUsd: result.costUsd } }) };
  }, { envelope, errorText: redactForEvidence });
  const onRestart = DISPATCH_STEPS[match]!;
  const parked = PARKED[match];
  return { ...route, onRestart, ...(parked && { reconcile: async () => ({ kind: "unknown" as const, evidence: parked }) }) };
}

async function plan(ports: BuildSurfacePorts, input: I.PlanInput) {
  const spec = parseBuildSpec(await ports.readText(input.specPath));
  if (spec.repo.toLowerCase() !== input.repo.toLowerCase()) throw new Error(`build spec is for ${spec.repo}, not ${input.repo}`);
  return { spec };
}

async function command(ports: BuildSurfacePorts, input: I.CommandInput, signal: AbortSignal) {
  const done = await ports.run(input.argv, { cwd: input.cwd, env: input.env, signal });
  return { pass: done.status === 0, status: done.status, detail: done.status === 0 ? tail(done.stdout) : `exited ${done.status}: ${tail(done.stderr || done.stdout)}` };
}

/** A validator accepts on exit 0; otherwise each non-empty stdout line is one rejection the agent gets back. */
async function validate(ports: BuildSurfacePorts, input: I.ValidateInput, signal: AbortSignal): Promise<Validation> {
  const rejections = [...input.builtIn];
  if (input.argv) {
    const done = await ports.run(input.argv, { cwd: input.cwd, env: input.env, input: JSON.stringify(input.payload), signal });
    const lines = done.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (done.status !== 0) rejections.push(...(lines.length > 0 ? lines : [`validator exited ${done.status}: ${tail(done.stderr)}`]));
  }
  return { accepted: rejections.length === 0, rejections };
}

async function reportCheck(ports: BuildSurfacePorts, input: I.ReportCheckInput, signal: AbortSignal): Promise<Validation> {
  const remote = await ports.github.getHeadSha(input.repo, input.branch);
  const builtIn = remote === input.head ? [] : [`head ${input.head} is not the head of ${input.branch} on the remote (${remote ?? "no such branch"})`];
  return validate(ports, { ...input, builtIn: [...input.builtIn, ...builtIn] }, signal);
}

async function branch(ports: BuildSurfacePorts, input: I.BranchInput) {
  const existing = await ports.github.getHeadSha(input.repo, input.branch);
  const baseSha = await ports.github.getHeadSha(input.repo, input.base);
  if (!baseSha) throw new Error(`base ${input.base} has no head on ${input.repo}`);
  if (existing) return { branch: input.branch, baseSha, created: false };
  await ports.github.ensureBranch(input.repo, input.branch, baseSha);
  return { branch: input.branch, baseSha, created: true };
}

/** Exit 0 and every gate's record passing at this head is green; a record for another head or none at all is a problem. */
async function gates(ports: BuildSurfacePorts, input: I.GatesInput, signal: AbortSignal): Promise<GateRun> {
  const done = await ports.run(input.argv, { cwd: input.cwd, env: input.env, signal });
  const problems: string[] = [];
  const records = (await ports.readEvidence(input.evidenceDir)).flatMap(({ path, json }) => {
    const parsed = GateEvidenceSchema.safeParse(json);
    if (!parsed.success) return (problems.push(`${path}: not a gate record`), []);
    if (parsed.data.head !== input.head) return (problems.push(`${path}: written for head ${parsed.data.head}`), []);
    return [{ gate: parsed.data.gate, pass: parsed.data.pass, ...(parsed.data.score !== undefined && { score: parsed.data.score }), evidence: path }];
  });
  if (records.length === 0) problems.push(`no gate evidence in ${input.evidenceDir}`);
  if (done.status !== 0 && records.every((record) => record.pass)) problems.push(`gate command exited ${done.status}: ${tail(done.stderr)}`);
  return { head: input.head, exitCode: done.status, pass: done.status === 0 && problems.length === 0 && records.every((record) => record.pass), gates: records, problems };
}

async function pr(ports: BuildSurfacePorts, input: I.PrInput) {
  const found = await ports.github.findPr(input.repo, input.branch);
  if (found) return { pr: found.number, url: `https://github.com/${input.repo}/pull/${found.number}`, created: false };
  const opened = await ports.github.openPr(input.repo, { head: input.branch, base: input.base, title: input.title, body: input.body });
  return { pr: opened.pr.number, url: `https://github.com/${input.repo}/pull/${opened.pr.number}`, created: true };
}

async function extract(ports: BuildSurfacePorts, input: I.ExtractInput, signal: AbortSignal) {
  const answer = await ports.extract({ ...input, signal });
  return { targets: answer.output, ...(answer.costUsd !== undefined && { costUsd: answer.costUsd }) };
}

/** The non-agent steps: each runs one port call, and only the deploy is routed to park. */
export function buildSurfaceCodeRoutes(ports: BuildSurfacePorts): StepRoute[] {
  return [
    bsRoute("bs-plan", ports, (input: I.PlanInput) => plan(ports, input)),
    bsRoute("bs-preflight", ports, (input: I.CommandInput, signal) => command(ports, input, signal)),
    bsRoute("bs-extract-check", ports, (input: I.ValidateInput, signal) => validate(ports, input, signal)),
    bsRoute("bs-branch", ports, (input: I.BranchInput) => branch(ports, input)),
    bsRoute("bs-report-check", ports, (input: I.ReportCheckInput, signal) => reportCheck(ports, input, signal)),
    bsRoute("bs-gates", ports, (input: I.GatesInput, signal) => gates(ports, input, signal)),
    bsRoute("bs-preview", ports, (input: I.CommandInput, signal) => command(ports, input, signal)),
    bsRoute("bs-review-check", ports, (input: I.ValidateInput, signal) => validate(ports, input, signal)),
    bsRoute("bs-pr", ports, (input: I.PrInput) => pr(ports, input)),
    bsRoute("bs-shepherd", ports, (input: I.ShepherdInput) => ports.shepherd.register(input)),
    bsRoute("bs-await-land", ports, (input: I.LandInput, signal): Promise<LandState> => ports.shepherd.land(input, signal)),
    bsRoute("bs-deploy", ports, (input: I.CommandInput, signal) => command(ports, input, signal)),
  ];
}

/** The judgment steps: one claude-print turn for extraction, agent-chat for the implementer, its fixes and the reviewer. */
export function buildSurfaceAgentRoutes(ports: BuildSurfacePorts): StepRoute[] {
  return [
    bsRoute("bs-extract", ports, (input: I.ExtractInput, signal) => extract(ports, input, signal)),
    bsRoute("bs-implement", ports, (input: I.ImplementInput, signal) => ports.implementer.start({ ...input, schema: ImplementerReportSchema }, signal)),
    bsRoute("bs-fix", ports, (input: I.FixInput, signal) => ports.implementer.resume(input.name, input.message, ImplementerReportSchema, signal)),
    bsRoute("bs-review", ports, (input: I.ImplementInput, signal) => ports.implementer.start({ ...input, role: "reviewer", schema: ReviewReportSchema }, signal)),
  ];
}

export function buildSurfaceRoutes(ports: BuildSurfacePorts): StepRoute[] {
  return [...buildSurfaceCodeRoutes(ports), ...buildSurfaceAgentRoutes(ports)];
}
