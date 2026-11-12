// The drafting half of the owner's task approval (gate model S8a, TP-5411): one task tagged owner-validate becomes a
// one-question round.json whose binding is a `task` plan approval. It writes nothing; the owner's approve pick, filed
// through the console, is the only path to the row.
import { isRepo } from "@titan-design/github";
import { buildPlanRound, type PlanRound } from "@titan-design/owner-queue";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { doneWhenHash } from "../dispatch/ops.js";
import { shownLine } from "./ci-policy-changes.js";
import { TASK_APPROVAL_REASONS, TaskKeySchema, type TaskScope } from "./plan-approval.js";
import { checkBindings, PlanRoundRefused } from "./plan-round.js";

export const OWNER_VALIDATE_TAG = "owner-validate";
const DEFAULT_TIMEOUT_MS = 3000;

/** The fields of one active-work task the round shows the owner and binds. */
export interface TaskForApproval {
  title: string;
  doneWhen: string;
  tags: string[];
}

export interface TaskApprovalReads {
  /** The task, or undefined when the initiative has no such task; a failed read throws. */
  task(initiative: string, id: string): Promise<TaskForApproval | undefined>;
}

type TaskListCommands = {
  "task.list": { args: { slug: string; status: "all" }; result: { tasks: { id: string; title?: string; done_when?: string; tags?: string[] }[] } };
};

/** One task over the active-work loopback rpc; it has no `task.show`, so the initiative's list is filtered by id. */
export function activeWorkTaskForApproval(options: { origin: string; fetch?: typeof fetch; timeoutMs?: number }): TaskApprovalReads {
  const client = createRpcClient<TaskListCommands>(liveSource(options));
  return {
    task: async (initiative, id) => {
      const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const { tasks } = await client.call("task.list", { slug: initiative, status: "all" }, { signal });
      const found = tasks.find((task) => task.id === id);
      return found === undefined ? undefined : { title: found.title ?? "", doneWhen: found.done_when ?? "", tags: found.tags ?? [] };
    },
  };
}

export interface TaskApprovalRequest {
  taskKey: string;
  repo: string;
  reason: string;
  visualSignoff: boolean;
  round: number;
  supersedes?: string[];
  storybookUrl?: string;
}

const isReason = (value: string): value is TaskScope["reason"] => (TASK_APPROVAL_REASONS as readonly string[]).includes(value);

function checkedRequest(request: TaskApprovalRequest): { initiative: string; id: string; reason: TaskScope["reason"] } {
  if (!TaskKeySchema.safeParse(request.taskKey).success) throw new PlanRoundRefused(`--task-approval takes <initiative>/<ID>; ${JSON.stringify(request.taskKey)} is not one`);
  if (!isRepo(request.repo)) throw new PlanRoundRefused(`--repo takes a bare owner/name; ${JSON.stringify(request.repo)} is not one`);
  if (!isReason(request.reason)) throw new PlanRoundRefused(`--reason is one of ${TASK_APPROVAL_REASONS.join(", ")}; ${JSON.stringify(request.reason)} is not`);
  const slash = request.taskKey.indexOf("/");
  return { initiative: request.taskKey.slice(0, slash), id: request.taskKey.slice(slash + 1), reason: request.reason };
}

const contextOf = (task: TaskForApproval, scope: TaskScope): string =>
  [`Done when: ${shownLine(task.doneWhen)}`, `Why it needs you: ${scope.reason}.`, `Visual sign-off at merge: ${scope.visualSignoff ? "yes" : "no"}.`].join("\n");

/** Refuses a key, reason or task the record would not hold, so nothing reaches the owner that their pick could not record. */
export async function taskApprovalRound(request: TaskApprovalRequest, reads: TaskApprovalReads): Promise<PlanRound> {
  const { initiative, id, reason } = checkedRequest(request);
  const task = await reads.task(initiative, id);
  if (task === undefined) throw new PlanRoundRefused(`active-work holds no task ${id} in ${initiative}`);
  if (!task.tags.includes(OWNER_VALIDATE_TAG)) throw new PlanRoundRefused(`${request.taskKey} is not tagged ${OWNER_VALIDATE_TAG}, so no task approval is asked for`);
  if (task.doneWhen.trim() === "") throw new PlanRoundRefused(`${request.taskKey} has no done_when for the owner to validate`);
  const scope: TaskScope = { doneWhenHash: doneWhenHash(task.doneWhen), reason, visualSignoff: request.visualSignoff };
  const ask = { gate: "task" as const, scope, title: shownLine(task.title) || id, context: contextOf(task, scope) };
  const unit = `validate-${request.taskKey.toLowerCase().replace(/\//g, "-")}`;
  const { round, supersedes, storybookUrl, taskKey, repo } = request;
  const built = buildPlanRound({ unit, round, task: taskKey, repo, asks: [ask], ...(supersedes && { supersedes }), ...(storybookUrl && { storybookUrl }) });
  checkBindings(built);
  return built;
}
