import { BetSchema, FreezeSchema, OutcomeSchema, OutOfScopeSchema, TaskSchema, type Bet, type Freeze, type OutOfScope, type Outcome, type Task } from "@titan-design/pm";
import { loadPlanRecords } from "@titan-design/pm/node";
import { createRpcClient, liveSource, RpcError, type LiveSourceOptions, type RpcClient } from "@titan-design/rpc-client";
import { z } from "zod";
import type { LaneTask } from "./back-pressure.js";
import type { SelectionPolicy } from "./intake.js";
import { evaluateEligibility, type Eligibility, type PlanView, type RefusedTask } from "./rules.js";

type Rows = { tasks: unknown[] };

/** The read-only slice of active-work's command table the eligibility reader calls. */
type EligibilityCommands = {
  "task.list": { args: { slug: string; status: "open" | "all"; tag?: string; id?: string }; result: Rows };
  "plan.bet.list": { args: { initiative: string; week: string; state: "selected" }; result: unknown[] };
  "plan.freeze.list": { args: { initiative: string }; result: unknown[] };
  "plan.out-of-scope.list": { args: { initiative: string }; result: unknown[] };
  "plan.outcome.list": { args: { initiative: string }; result: unknown[] };
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

interface PlanRecords {
  bets: Bet[];
  freezes: Freeze[];
  outOfScope: OutOfScope[];
  outcomes?: Outcome[];
}

async function rpcPlanRecords(client: Client, query: EligibilityQuery, withOutcomes: boolean): Promise<PlanRecords> {
  const { initiative, week } = query;
  const [bets, freezes, outOfScope, outcomes] = await Promise.all([
    client.call("plan.bet.list", { initiative, week, state: "selected" }).then((rows) => z.array(BetSchema).parse(rows)),
    client.call("plan.freeze.list", { initiative }).then((rows) => z.array(FreezeSchema).parse(rows)),
    client.call("plan.out-of-scope.list", { initiative }).then((rows) => z.array(OutOfScopeSchema).parse(rows)),
    withOutcomes ? client.call("plan.outcome.list", { initiative }).then((rows) => z.array(OutcomeSchema).parse(rows)) : undefined,
  ]);
  return { bets, freezes, outOfScope, ...(outcomes && { outcomes }) };
}

/** The same records the daemon's `plan.*` lists serve, read from its plan store; a missing plan folder holds none. */
async function filePlanRecords(activeRoot: string, query: EligibilityQuery): Promise<PlanRecords> {
  const { initiative, week } = query;
  const [bets, freezes, outOfScope, outcomes] = await Promise.all([
    loadPlanRecords(activeRoot, initiative, "bet"),
    loadPlanRecords(activeRoot, initiative, "freeze"),
    loadPlanRecords(activeRoot, initiative, "out-of-scope"),
    loadPlanRecords(activeRoot, initiative, "outcome"),
  ]);
  return { bets: bets.filter((bet) => bet.week === week && bet.state === "selected"), freezes, outOfScope, outcomes };
}

async function planView(client: Client, query: EligibilityQuery, records: PlanRecords): Promise<PlanView> {
  const active = await Promise.all(records.freezes.map((freeze) => freezeActive(client, freeze, query.today)));
  const bets = [...records.bets].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const freezes = records.freezes.filter((_, at) => active[at]);
  return { initiative: query.initiative, bets, freezes, outOfScope: records.outOfScope, ...(records.outcomes && { outcomes: records.outcomes }) };
}

const readPlan = async (client: Client, query: EligibilityQuery): Promise<PlanView> => planView(client, query, await rpcPlanRecords(client, query, false));

type PlanReadSource = "rpc" | "file";

const unknownCommand = (error: unknown): boolean => error instanceof RpcError && error.message.startsWith("Unknown command");

/** A daemon built before `plan.*` answers Unknown command; only that answer falls back to the files, so an outage still fails closed. */
async function shadowPlan(client: Client, query: EligibilityQuery, activeRoot: string): Promise<{ plan: PlanView; planRead: PlanReadSource }> {
  let records: PlanRecords;
  let planRead: PlanReadSource = "rpc";
  try {
    records = await rpcPlanRecords(client, query, true);
  } catch (error) {
    if (!unknownCommand(error)) throw error;
    records = await filePlanRecords(activeRoot, query);
    planRead = "file";
  }
  return { plan: await planView(client, query, records), planRead };
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

const LaneTaskRow = z.object({ id: z.string(), created: z.string(), done_at: z.string().nullish(), status: z.string().optional(), source: z.string().optional(), owner_steps: z.array(z.object({ kind: z.string() })).optional() });

/** What the lane's flow and the landed rules read from one task row. */
export interface LaneTaskRead extends LaneTask {
  key: string;
  status: string | undefined;
  source: string | undefined;
  ownerSteps: readonly { kind: string }[];
}

/** Every task of the lane, open or done, keyed `initiative/ID`; a row without an id or created date is left out of the flow. */
export async function readLaneTasks(options: LiveSourceOptions, lane: { initiative: string; tag?: string }): Promise<{ keys: Set<string>; tasks: LaneTaskRead[] }> {
  const client = createRpcClient<EligibilityCommands>(liveSource(options));
  const { tasks: rows } = await client.call("task.list", { slug: lane.initiative, status: "all", ...(lane.tag !== undefined && { tag: lane.tag }) });
  const parsed = rows.flatMap((row) => LaneTaskRow.safeParse(row).data ?? []);
  return { keys: new Set(parsed.map((row) => `${lane.initiative}/${row.id}`)), tasks: parsed.map((row) => ({ key: `${lane.initiative}/${row.id}`, created: row.created, doneAt: row.done_at ?? null, status: row.status, source: row.source, ownerSteps: row.owner_steps ?? [] })) };
}

/** The open tasks of one initiative (or one lane of it), judged against the week's plan over active-work's loopback rpc. Reads only. */
export async function readEligibility(options: LiveSourceOptions, query: EligibilityQuery): Promise<Eligibility> {
  const client = createRpcClient<EligibilityCommands>(liveSource(options));
  const [{ tasks: rows }, plan] = await Promise.all([readOpenTasks(client, query), readPlan(client, query)]);
  return judge(rows, plan, async () => undefined);
}

function readOpenTasks(client: Client, query: EligibilityQuery): Promise<Rows> {
  const listArgs = { slug: query.initiative, status: "open" as const, ...(query.tag !== undefined && { tag: query.tag }) };
  return client.call("task.list", listArgs);
}

/** A row that does not parse as a task is refused as unreadable, never dropped. */
async function judge(rows: readonly unknown[], plan: PlanView, policyFor: (tasks: readonly Task[]) => Promise<SelectionPolicy | undefined>): Promise<Eligibility> {
  const { tasks, unreadable } = parseTasks(rows);
  const result = evaluateEligibility(tasks, plan, await policyFor(tasks));
  return { eligible: result.eligible, refused: [...result.refused, ...unreadable] };
}

interface ShadowReadContext {
  activeRoot: string;
  /** Builds the policy once the tasks are read, since some of its facts are keyed by what the tasks cite. */
  policyFor: (tasks: readonly Task[]) => Promise<SelectionPolicy>;
}

/** As `readEligibility`, under a policy and with the plan-read fallback; the shadow tick's reader only. */
export async function readShadowEligibility(options: LiveSourceOptions, query: EligibilityQuery, context: ShadowReadContext): Promise<{ result: Eligibility; planRead: PlanReadSource }> {
  const client = createRpcClient<EligibilityCommands>(liveSource(options));
  const [{ tasks: rows }, { plan, planRead }] = await Promise.all([readOpenTasks(client, query), shadowPlan(client, query, context.activeRoot)]);
  return { result: await judge(rows, plan, context.policyFor), planRead };
}
