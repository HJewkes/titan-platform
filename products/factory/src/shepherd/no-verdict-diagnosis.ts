import { open } from "node:fs/promises";
import { dataFence } from "@titan-design/agent-dispatch";
import type { AgentRow } from "@titan-design/agent-dispatch";
import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { AgentChatAgents } from "./agents.js";
import type { ReviewerSeen } from "./no-verdict-round.js";
import { resolveCheckout } from "./reviewer-dispatch.js";

const DIAGNOSIS_STEP = "sh-no-verdict-diagnosis";
export const DIAGNOSIS_STEPS: readonly StepDeclaration[] = [{ id: DIAGNOSIS_STEP, kind: "dispatch" }];

/** `shepherd.diagnosisProfile` when absent: a planner works out why reviews fail, and never reviews the PR itself. */
export const DEFAULT_DIAGNOSIS_PROFILE = "bd-planner";
/** The newest log lines naming a no-verdict reviewer that the brief quotes. */
const MAX_LOG_LINES = 40;
/** How much of the log's tail is searched; older lines predate the rounds that failed. */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

/** How the diagnosis planner is spawned; the profile is passed to agent-chat as configured, never lowered. */
export interface DiagnosisPorts {
  profile: string;
  /** Absent means no agent-chat is configured, so the spawn is recorded as failed and the ops notice goes instead. */
  agents?: Pick<AgentChatAgents, "roster" | "spawn">;
  /** The repo's checkout, which the planner starts in. */
  cwdFor?: (repo: string) => string | undefined;
  /** The tail of `serve.err.log`; absent or undefined quotes no log lines. */
  readLog?: () => Promise<string | undefined>;
  /** The seat the planner reports to; absent means it reports to its spawner. */
  reportTo?: () => string | undefined;
}

const Reviewer = z.object({
  ...{ head: z.string(), shape: z.string(), name: z.string().optional(), agentId: z.string().optional() },
  ...{ sessionId: z.string().optional(), refused: z.string().optional(), verdict: z.literal(true).optional() },
});
const DiagnosisInput = z.object({
  ...{ runId: z.string().min(1), repo: z.string().min(1), pr: z.number().int().positive(), headSha: z.string().min(1) },
  ...{ task: z.string().optional(), failedOutcomes: z.array(z.string()), reviewers: z.array(Reviewer) },
});
type DiagnosisInput = z.infer<typeof DiagnosisInput>;

const DiagnosisResult = z.looseObject({ spawned: z.boolean(), agent: z.string(), profile: z.string().optional(), reason: z.string().optional() });
type DiagnosisResult = z.infer<typeof DiagnosisResult>;

/** Unique per run and head, and one argv word agent-chat takes as a name. */
export function diagnosisName(runId: string, headSha: string): string {
  return `diag-${headSha.slice(0, 8)}-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

function transcriptOf(reviewer: ReviewerSeen, roster: readonly AgentRow[]): string {
  if (reviewer.sessionId === undefined) return `never started (${reviewer.refused ?? "no dispatch was recorded"})`;
  const row = roster.find((candidate) => candidate.sessionId === reviewer.sessionId || (reviewer.agentId !== undefined && candidate.agentId === reviewer.agentId));
  const path = typeof row?.transcriptPath === "string" ? row.transcriptPath : "not on the roster";
  return `session ${reviewer.sessionId}, transcript ${path}`;
}

function reviewerLine(reviewer: ReviewerSeen, roster: readonly AgentRow[]): string {
  return `- ${reviewer.shape} reviewer ${reviewer.name ?? "(unnamed)"} at ${reviewer.head}: ${transcriptOf(reviewer, roster)}`;
}

/** The newest lines that name a no-verdict reviewer by name, agent id or session id. */
function matchingLogLines(log: string | undefined, reviewers: readonly ReviewerSeen[]): string[] {
  const keys = reviewers.flatMap((reviewer) => [reviewer.name, reviewer.agentId, reviewer.sessionId]).filter((key): key is string => key !== undefined && key !== "");
  if (log === undefined || keys.length === 0) return [];
  return log.split("\n").filter((line) => keys.some((key) => line.includes(key))).slice(-MAX_LOG_LINES);
}

const TASK_STEPS = [
  "Read each transcript and the log lines. For every reviewer, work out why it ended with no Verdict line: a refused spawn, a profile that is not installed, a crash, a timeout, a brief it could not follow, or something in the PR itself.",
  "Do not review, push to or merge the PR, and do not start another reviewer.",
  "Report the root cause per reviewer, the evidence lines, and the fix. File the fix as a task when it is a Shepherd or reviewer defect.",
];

function diagnosisBrief(input: DiagnosisInput, roster: readonly AgentRow[], logLines: readonly string[], reportTo: string | undefined): string {
  const silent = input.reviewers.filter((reviewer) => reviewer.verdict !== true);
  return [
    `Shepherd's review rounds of ${input.repo}#${input.pr} delivered no verdict. Work out why, instead of a fourth blind review or an owner gate.`,
    "",
    ...[`Repo: ${input.repo}`, `PR: ${input.pr}`, `Head: ${input.headSha}`, `Shepherd run: ${input.runId}`, `Task: ${input.task ?? "unknown"}`],
    `Failed rounds: ${input.failedOutcomes.join(", ") || "none counted"}`,
    "",
    "Reviewers that gave no verdict:",
    ...(silent.length > 0 ? silent.map((reviewer) => reviewerLine(reviewer, roster)) : ["- none recorded: the review returned no verdict without dispatching a reviewer Shepherd could see"]),
    "",
    logLines.length > 0 ? dataFence("serve.err.log lines naming these reviewers oldest first", logLines.join("\n")) : "serve.err.log: no line names these reviewers.",
    "",
    ...TASK_STEPS.map((line, index) => `${index + 1}. ${line}`),
    ...(reportTo === undefined ? [] : [`Send the report to ${reportTo} with chat_send.`]),
  ].join("\n");
}

/** An agent already on the roster under this name is this head's planner, started before a crash lost the record. */
async function spawnPlanner(ports: DiagnosisPorts, input: DiagnosisInput, agent: string): Promise<void> {
  if (ports.agents === undefined) throw new Error("no agent-chat is configured");
  const checkout = resolveCheckout(input.repo, ports.cwdFor?.(input.repo));
  if ("problem" in checkout) throw new Error(checkout.problem);
  const roster = await ports.agents.roster();
  if (roster.some((row) => row.name === agent)) return;
  const silent = input.reviewers.filter((reviewer) => reviewer.verdict !== true);
  const logLines = matchingLogLines(await ports.readLog?.().catch(() => undefined), silent);
  await ports.agents.spawn({ name: agent, profile: ports.profile, brief: diagnosisBrief(input, roster, logLines, ports.reportTo?.()), cwd: checkout.dir });
}

/** Never throws: a refused spawn or a missing checkout is recorded as failed, and the run tells ops instead. */
export async function spawnDiagnosis(ports: DiagnosisPorts | undefined, input: DiagnosisInput): Promise<DiagnosisResult> {
  const agent = diagnosisName(input.runId, input.headSha);
  if (ports === undefined) return { spawned: false, agent, reason: "no diagnosis planner is wired" };
  try {
    await spawnPlanner(ports, input, agent);
    return { spawned: true, agent, profile: ports.profile };
  } catch (error) {
    return { spawned: false, agent, profile: ports.profile, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function diagnosisRoutes(deps: { now: () => number; diagnosis?: DiagnosisPorts }): StepRoute[] {
  return [codeRoute(DIAGNOSIS_STEP, deps.now, async (raw: unknown) => spawnDiagnosis(deps.diagnosis, DiagnosisInput.parse(raw)))];
}

/** What the run hands its planner: the PR, the head, and every reviewer of the failed rounds. */
interface DiagnosisRun {
  ctx: WorkflowContext;
  target: { repo: RepoSlug; pr: number };
  task?: string;
  failedOutcomes: string[];
  failedReviewers: ReviewerSeen[];
}

/** One planner per run and head: a replay or a second escalation at the head returns the recorded spawn. */
export function requestDiagnosis(run: DiagnosisRun, headSha: string): Promise<DiagnosisResult> {
  const input = { runId: run.ctx.runId, ...run.target, headSha, ...(run.task !== undefined && { task: run.task }), failedOutcomes: run.failedOutcomes, reviewers: run.failedReviewers };
  return step(run.ctx, `${DIAGNOSIS_STEP}:${headSha}`, input, DiagnosisResult);
}

/** The last `LOG_TAIL_BYTES` of the log; a missing file reads as undefined. */
export async function readLogTail(path: string): Promise<string | undefined> {
  const file = await open(path, "r").catch(() => undefined);
  if (file === undefined) return undefined;
  try {
    const { size } = await file.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}
