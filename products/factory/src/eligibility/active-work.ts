import { BetSchema, FreezeSchema, OutOfScopeSchema, TaskSchema, type Freeze, type Task } from "@titan-design/pm";
import { createRpcClient, liveSource, type LiveSourceOptions, type RpcClient } from "@titan-design/rpc-client";
import { z } from "zod";
import type { LaneTask } from "./back-pressure.js";
import { evaluateEligibility, type Eligibility, type PlanView, type RefusedTask } from "./rules.js";

type Rows = { tasks: unknown[] };

/** The read-only slice of active-work's command table the eligibility reader calls. */
type EligibilityCommands = {
  "task.list": { args: { slug: string; status: "open" | "all"; tag?: string; id?: string }; result: Rows };
  "plan.bet.list": { args: { initiative: string; week: string; state: "selected" }; result: unknown[] };
  "plan.freeze.list": { args: { initiative: string }; result: unknown[] };
  "plan.out-of-scope.list": { args: { initiative: string }; result: unknown[] };
};

interface EligibilityQuery {
  initiative: string;
  /** ISO week, `YYYY-Www`. */
  week: string;
  /** Today as `YYYY-MM-DD`, for freezes that end on a date. */
  today: string;
  /** Narrows the candidates to one lane's tag. */
  tag?: string;
}

type Client = RpcClient<EligibilityCommands>;

async function taskIsDone(client: Client, key: string): Promise<boolean> {
  const slash = key.indexOf("/");
  const { tasks } = await client.call("task.list", { slug: key.slice(0, slash), id: key.slice(slash + 1), status: "all" });
  return tasks.some((row) => z.object({ status: z.literal("done") }).safeParse(row).success);
}

/** Whether a freeze is still in force: not ended by the owner, and an end condition this reader cannot measure keeps it in force. */
async function freezeActive(client: Client, freeze: Freeze, today: string): Promise<boolean> {
  if (freeze.ended_on !== undefined) return false;
  const end = freeze.end_condition;
  if (end.kind === "date") return today < end.date;
  if (end.kind === "task-done") return !(await taskIsDone(client, end.task));
  return true;
}

async function readPlan(client: Client, query: EligibilityQuery): Promise<PlanView> {
  const { initiative, week } = query;
  const [bets, freezes, outOfScope] = await Promise.all([
    client.call("plan.bet.list", { initiative, week, state: "selected" }).then((rows) => z.array(BetSchema).parse(rows)),
    client.call("plan.freeze.list", { initiative }).then((rows) => z.array(FreezeSchema).parse(rows)),
    client.call("plan.out-of-scope.list", { initiative }).then((rows) => z.array(OutOfScopeSchema).parse(rows)),
  ]);
  const active = await Promise.all(freezes.map((freeze) => freezeActive(client, freeze, query.today)));
  const ordered = [...bets].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { initiative, bets: ordered, freezes: freezes.filter((_, at) => active[at]), outOfScope };
}

const rowId = (row: unknown): string => z.object({ id: z.string() }).safeParse(row).data?.id ?? "(no id)";

function parseTasks(rows: readonly unknown[]): { tasks: Task[]; unreadable: RefusedTask[] } {
  const tasks: Task[] = [];
  const unreadable: RefusedTask[] = [];
  for (const row of rows) {
    const parsed = TaskSchema.safeParse(row);
    if (parsed.success) tasks.push(parsed.data);
    else unreadable.push({ id: rowId(row), refusals: [{ code: "unreadable", detail: "does not parse as a pm task" }] });
  }
  return { tasks, unreadable };
}

const LaneTaskRow = z.object({ id: z.string(), created: z.string(), done_at: z.string().nullish() });

/** Every task of the lane, open or done, keyed `initiative/ID`; a row without an id or created date is left out of the flow. */
export async function readLaneTasks(options: LiveSourceOptions, lane: { initiative: string; tag?: string }): Promise<{ keys: Set<string>; tasks: LaneTask[] }> {
  const client = createRpcClient<EligibilityCommands>(liveSource(options));
  const { tasks: rows } = await client.call("task.list", { slug: lane.initiative, status: "all", ...(lane.tag !== undefined && { tag: lane.tag }) });
  const parsed = rows.flatMap((row) => LaneTaskRow.safeParse(row).data ?? []);
  return { keys: new Set(parsed.map((row) => `${lane.initiative}/${row.id}`)), tasks: parsed.map((row) => ({ created: row.created, doneAt: row.done_at ?? null })) };
}

/** The open tasks of one initiative (or one lane of it), judged against the week's plan over active-work's loopback rpc. Reads only. */
export async function readEligibility(options: LiveSourceOptions, query: EligibilityQuery): Promise<Eligibility> {
  const client = createRpcClient<EligibilityCommands>(liveSource(options));
  const listArgs = { slug: query.initiative, status: "open" as const, ...(query.tag !== undefined && { tag: query.tag }) };
  const [{ tasks: rows }, plan] = await Promise.all([client.call("task.list", listArgs), readPlan(client, query)]);
  const { tasks, unreadable } = parseTasks(rows);
  const result = evaluateEligibility(tasks, plan);
  return { eligible: result.eligible, refused: [...result.refused, ...unreadable] };
}
