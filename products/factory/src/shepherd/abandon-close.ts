import type { GitHubPort } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { runCommand, type CommandResult } from "../run-command.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";
import type { CleanupTasks } from "./ports.js";
import type { GateRun } from "./run-state.js";

/** TP-4759 S3 (owner decision 552): a dead-end gate answered abandon closes the PR, keeps its branch and reopens its task. */
const ABANDON_STEP = "sh-abandon";
export const ABANDON_STEPS: readonly StepDeclaration[] = [{ id: ABANDON_STEP, kind: "dispatch" }];

const OUTCOMES = ["closed", "already-closed", "merged", "moved", "advisory"] as const;
type AbandonOutcome = (typeof OUTCOMES)[number];
const TASK_STATES = ["reopened", "no-task", "unreachable"] as const;
type TaskState = (typeof TASK_STATES)[number];

const AbandonInput = z.object({ repo: z.string().min(1), pr: z.number().int().positive(), headSha: z.string().min(1) });
type AbandonTarget = z.infer<typeof AbandonInput>;
const AbandonResult = z.looseObject({ outcome: z.enum(OUTCOMES), task: z.enum(TASK_STATES), headSha: z.string() });

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

interface AbandonPorts {
  port: Pick<GitHubPort, "getPr">;
  agentChatBin: string;
  run: Run;
  /** The registered task as `<initiative>/<id>`; undefined when no registration names one. */
  task(target: { repo: string; pr: number }): string | undefined;
  /** True for a repo where Shepherd never writes; absent means none is. */
  advisory?: (repo: string) => boolean;
  /** Absent means the task is left as it is and the result says `no-task`. */
  tasks?: Pick<CleanupTasks, "reopen" | "appendNote">;
}

/** Never `--delete-branch`: the branch stays, so reopening the PR is one click. gh-write is the factory's write path. */
async function closeThroughGhWrite(ports: AbandonPorts, { repo, pr }: AbandonTarget): Promise<void> {
  const done = await ports.run(ports.agentChatBin, ["gh-write", "--", "pr", "close", String(pr), "--repo", repo]);
  if (done?.code !== 0) throw new Error(`could not close ${repo}#${pr}: ${done?.stderr.trim() ?? `${ports.agentChatBin} is not on PATH`}`);
}

/**
 * An advisory repo is refused before any read, because this close runs outside the advisory-wrapped port. A closed PR is
 * read before the head guard, so a replay after the close reopens the task without closing again.
 */
async function closeAtHead(ports: AbandonPorts, target: AbandonTarget): Promise<AbandonOutcome> {
  if (ports.advisory?.(target.repo)) return "advisory";
  const pull = await ports.port.getPr(target.repo, target.pr);
  if (pull.merged) return "merged";
  if (pull.state !== "open") return "already-closed";
  if (pull.headSha !== target.headSha) return "moved";
  await closeThroughGhWrite(ports, target);
  return "closed";
}

/** Both writes are idempotent, so a replay lands the same task; a task that cannot be reached leaves the close standing. */
async function reopenTask(ports: AbandonPorts, target: AbandonTarget): Promise<TaskState> {
  const key = ports.task(target);
  const slash = key?.indexOf("/") ?? -1;
  if (ports.tasks === undefined || key === undefined || slash <= 0 || slash === key.length - 1) return "no-task";
  const [initiative, id] = [key.slice(0, slash), key.slice(slash + 1)];
  try {
    await ports.tasks.reopen(initiative, id);
    await ports.tasks.appendNote(initiative, id, `reopened by Shepherd: ${target.repo}#${target.pr} closed at ${target.headSha} on a dead-end abandon`);
    return "reopened";
  } catch {
    return "unreachable";
  }
}

export const abandonCloseRoute = (now: () => number, ports: AbandonPorts): StepRoute =>
  codeRoute(ABANDON_STEP, now, async (raw: unknown) => {
    const target = AbandonInput.parse(raw);
    const outcome = await closeAtHead(ports, target);
    const task = outcome === "closed" || outcome === "already-closed" ? await reopenTask(ports, target) : "no-task";
    return { outcome, task, headSha: target.headSha };
  });

/** Serve's ports: GitHub for the guard, `agent-chat gh-write` for the close, the registration's task and active-work. */
export const abandonRoute = (deps: Pick<ShepherdDeps, "now" | "port" | "store" | "agentChatBin" | "cleanup" | "advisory">): StepRoute =>
  abandonCloseRoute(deps.now, {
    port: deps.port,
    agentChatBin: deps.agentChatBin,
    run: runCommand,
    ...(deps.advisory && { advisory: deps.advisory }),
    task: ({ repo, pr }) => deps.store.get().byPr(repo, pr)?.task,
    ...(deps.cleanup && { tasks: deps.cleanup.tasks }),
  });

/**
 * Undefined when the PR moved past the gate head: nothing was closed, and the next round asks again at the new head. On an
 * advisory repo nothing is closed or reopened and the run only stops.
 */
export async function abandonAtHead(run: GateRun, headSha: string): Promise<LandOutcome | undefined> {
  const done = await step(run.ctx, ABANDON_STEP, { ...run.target, headSha }, AbandonResult);
  if (done.outcome === "moved") return undefined;
  const detail = `the dead-end gate at ${headSha} was answered abandon: PR ${done.outcome}, task ${done.task}`;
  return { kind: "stopped", reason: "abandoned", headSha, detail };
}
