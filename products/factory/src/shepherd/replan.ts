import type { AgentRow } from "@titan-design/agent-dispatch";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import type { ReplanPorts } from "./spawn-ports.js";

const REPLAN_STEP = "sh-replan";
export const REPLAN_STEPS: readonly StepDeclaration[] = [{ id: REPLAN_STEP, kind: "dispatch" }];

/** `shepherd.replanProfile` when absent: a dead end the worker cannot get past is the planner's to redesign or split (decision 515). */
export const DEFAULT_REPLAN_PROFILE = "bd-planner";

const FailedSession = z.object({ agent: z.string().min(1), sessionId: z.string().optional() });
/** A worker session the run saw end at this dead end; the transcript path is read off the roster at spawn time. */
export type FailedSession = z.infer<typeof FailedSession>;

const ReplanInput = z.object({
  ...{ runId: z.string().min(1), repo: z.string().min(1), pr: z.number().int().positive(), headSha: z.string().min(1) },
  ...{ kind: z.string().min(1), situation: z.string(), seat: z.string().min(1), task: z.string().optional() },
  ...{ sessions: z.array(FailedSession), trail: z.array(z.string()) },
});
type ReplanInput = z.infer<typeof ReplanInput>;

const ReplanResult = z.looseObject({ spawned: z.boolean(), agent: z.string(), profile: z.string().optional(), reason: z.string().optional() });
type ReplanResult = z.infer<typeof ReplanResult>;

/** Unique per run and head, and one argv word agent-chat takes as a name. */
function replanName(runId: string, headSha: string): string {
  return `replan-${headSha.slice(0, 8)}-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

function sessionLine(session: FailedSession, roster: readonly AgentRow[]): string {
  const row = roster.find((candidate) => candidate.name === session.agent || (session.sessionId !== undefined && candidate.sessionId === session.sessionId));
  const sessionId = session.sessionId ?? row?.sessionId ?? "unknown";
  const path = typeof row?.transcriptPath === "string" ? row.transcriptPath : "not on the roster";
  return `- ${session.agent}: session ${sessionId}, transcript ${path}`;
}

const TASK_STEPS = [
  "Read each transcript and the FIX_FIRST trail. Work out why the work keeps reaching this dead end: a task too large for one PR, a design the reviews keep rejecting, or a fix the worker cannot find.",
  "Redesign the task or split it into slices, and file what changes as task edits or new tasks.",
  "Do not push to, review or merge the PR yourself.",
];

function replanBrief(input: ReplanInput, roster: readonly AgentRow[]): string {
  return [
    `Shepherd's run of ${input.repo}#${input.pr} reached a dead end (${input.kind}) and seat ${input.seat} asked for a replan.`,
    "",
    ...[`Repo: ${input.repo}`, `PR: ${input.pr}`, `Head: ${input.headSha}`, `Shepherd run: ${input.runId}`, `Task: ${input.task ?? "unknown"}`],
    `Situation: ${input.situation}`,
    "",
    "Failed sessions:",
    ...(input.sessions.length > 0 ? input.sessions.map((session) => sessionLine(session, roster)) : ["- none recorded"]),
    "",
    "FIX_FIRST trail:",
    ...(input.trail.length > 0 ? input.trail.map((line) => `- ${line}`) : ["- none recorded"]),
    "",
    ...TASK_STEPS.map((line, index) => `${index + 1}. ${line}`),
    `Send the plan to ${input.seat} with chat_send; Shepherd waits for a new head of the PR.`,
  ].join("\n");
}

/** An agent already on the roster under this name is this head's planner, started before a crash lost the record. */
async function spawnPlanner(ports: ReplanPorts, input: ReplanInput, agent: string): Promise<void> {
  if (ports.agents === undefined) throw new Error("no agent-chat is configured");
  const checkout = resolveCheckout(input.repo, ports.cwdFor?.(input.repo));
  if ("problem" in checkout) throw new Error(checkout.problem);
  const roster = await ports.agents.roster();
  if (roster.some((row) => row.name === agent)) return;
  await ports.agents.spawn({ name: agent, profile: ports.profile, brief: replanBrief(input, roster), cwd: checkout.dir });
}

/** Never throws: a refused or deferred spawn is recorded as failed, and the run tells the seat and asks again. */
async function spawnReplan(ports: ReplanPorts | undefined, input: ReplanInput): Promise<ReplanResult> {
  const agent = replanName(input.runId, input.headSha);
  if (ports === undefined) return { spawned: false, agent, reason: "no replan planner is wired" };
  try {
    await spawnPlanner(ports, input, agent);
    return { spawned: true, agent, profile: ports.profile };
  } catch (error) {
    return { spawned: false, agent, profile: ports.profile, reason: error instanceof Error ? error.message : String(error) };
  }
}

export const replanRoute = (deps: { now: () => number; replan?: ReplanPorts }): StepRoute =>
  codeRoute(REPLAN_STEP, deps.now, async (raw: unknown) => spawnReplan(deps.replan, ReplanInput.parse(raw)));

/** What the dead-end gate hands its planner beyond the run's own target. */
interface ReplanAsk {
  headSha: string;
  kind: string;
  situation: string;
  seat: string;
  task?: string;
  sessions?: readonly FailedSession[];
  trail?: readonly string[];
}

/** A replay returns the recorded spawn; each replan answer at a head asks again, so a refused one can be retried. */
export function requestReplan(run: { ctx: WorkflowContext; target: { repo: string; pr: number } }, ask: ReplanAsk): Promise<ReplanResult> {
  const { sessions = [], trail = [], task, ...rest } = ask;
  const input = { runId: run.ctx.runId, ...run.target, ...rest, ...(task !== undefined && { task }), sessions: [...sessions], trail: [...trail] };
  return step(run.ctx, `${REPLAN_STEP}:${ask.headSha}`, input, ReplanResult);
}
