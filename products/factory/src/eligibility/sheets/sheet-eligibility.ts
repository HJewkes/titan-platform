import { BetSchema, FreezeSchema, OutcomeSchema, OutOfScopeSchema, TaskSchema, type Bet, type Freeze, type Task } from "@titan-design/pm";
import { loadPlanRecords } from "@titan-design/pm/node";
import { createRpcClient, liveSource, RpcError, type LiveSourceOptions, type RpcClient } from "@titan-design/rpc-client";
import { z } from "zod";
import type { SelectionPolicy } from "../intake.js";
import { evaluateEligibility, type Eligibility, type PlanView, type RefusedTask } from "../rules.js";

/*
 * The plan read for a lane that may fall back to its bet sheet (TP-5755 S7). It reads the same records as the shadow
 * plan read in active-work.ts, and with the same Unknown-command fallback to the plan store, but swaps in the sheet's
 * proposed bets when the store holds no selected bet for the week. That file belongs to another slice, hence the copy.
 */

type Rows = { tasks: unknown[] };

type PlanCommands = {
  "task.list": { args: { slug: string; status: "open" | "all"; tag?: string; id?: string }; result: Rows };
  "plan.bet.list": { args: { initiative: string; week: string; state: "selected" }; result: unknown[] };
  "plan.freeze.list": { args: { initiative: string }; result: unknown[] };
  "plan.out-of-scope.list": { args: { initiative: string }; result: unknown[] };
  "plan.outcome.list": { args: { initiative: string }; result: unknown[] };
};

type Client = RpcClient<PlanCommands>;

export interface SheetQuery {
  initiative: string;
  week: string;
  today: string;
  tag?: string;
}

type PlanRecords = Omit<PlanView, "initiative">;

async function rpcRecords(client: Client, { initiative, week }: SheetQuery): Promise<PlanRecords> {
  const [bets, freezes, outOfScope, outcomes] = await Promise.all([
    client.call("plan.bet.list", { initiative, week, state: "selected" }).then((rows) => z.array(BetSchema).parse(rows)),
    client.call("plan.freeze.list", { initiative }).then((rows) => z.array(FreezeSchema).parse(rows)),
    client.call("plan.out-of-scope.list", { initiative }).then((rows) => z.array(OutOfScopeSchema).parse(rows)),
    client.call("plan.outcome.list", { initiative }).then((rows) => z.array(OutcomeSchema).parse(rows)),
  ]);
  return { bets, freezes, outOfScope, outcomes };
}

async function fileRecords(activeRoot: string, { initiative, week }: SheetQuery): Promise<PlanRecords> {
  const [bets, freezes, outOfScope, outcomes] = await Promise.all([
    loadPlanRecords(activeRoot, initiative, "bet"),
    loadPlanRecords(activeRoot, initiative, "freeze"),
    loadPlanRecords(activeRoot, initiative, "out-of-scope"),
    loadPlanRecords(activeRoot, initiative, "outcome"),
  ]);
  return { bets: bets.filter((bet) => bet.week === week && bet.state === "selected"), freezes, outOfScope, outcomes };
}

const unknownCommand = (error: unknown): boolean => error instanceof RpcError && error.message.startsWith("Unknown command");

async function planRecords(client: Client, query: SheetQuery, activeRoot: string): Promise<{ records: PlanRecords; planRead: "rpc" | "file" }> {
  try {
    return { records: await rpcRecords(client, query), planRead: "rpc" };
  } catch (error) {
    if (!unknownCommand(error)) throw error;
    return { records: await fileRecords(activeRoot, query), planRead: "file" };
  }
}

async function taskIsDone(client: Client, key: string): Promise<boolean> {
  const slash = key.indexOf("/");
  const { tasks } = await client.call("task.list", { slug: key.slice(0, slash), id: key.slice(slash + 1), status: "all" });
  return tasks.some((row) => z.object({ status: z.literal("done") }).safeParse(row).success);
}

/** As active-work.ts: an end condition this reader cannot measure keeps the freeze in force. */
async function freezeActive(client: Client, freeze: Freeze, today: string): Promise<boolean> {
  if (freeze.ended_on !== undefined) return false;
  const end = freeze.end_condition;
  if (end.kind === "date") return today < end.date;
  if (end.kind === "task-done") return !(await taskIsDone(client, end.task));
  return true;
}

function parseTasks(rows: readonly unknown[]): { tasks: Task[]; unreadable: RefusedTask[] } {
  const tasks: Task[] = [];
  const unreadable: RefusedTask[] = [];
  for (const row of rows) {
    const parsed = TaskSchema.safeParse(row);
    if (parsed.success) tasks.push(parsed.data);
    else unreadable.push({ id: z.object({ id: z.string() }).safeParse(row).data?.id ?? "(no id)", refusals: [{ code: "unreadable", detail: "does not parse as a pm task" }] });
  }
  return { tasks, unreadable };
}

interface SheetReadContext {
  activeRoot: string;
  policyFor: (tasks: readonly Task[]) => Promise<SelectionPolicy>;
}

/**
 * Undefined when the store holds a selected bet this week, so the caller keeps the selected basis; otherwise the lane
 * judged against `sheetBets`, which is asked only then, so a broken sheet cannot matter to a lane the owner has selected for.
 */
export async function readSheetEligibility(
  source: LiveSourceOptions,
  query: SheetQuery,
  context: SheetReadContext,
  sheetBets: () => readonly Bet[],
): Promise<{ result: Eligibility; planRead: "rpc" | "file" } | undefined> {
  const client = createRpcClient<PlanCommands>(liveSource(source));
  const listArgs = { slug: query.initiative, status: "open" as const, ...(query.tag !== undefined && { tag: query.tag }) };
  const [{ tasks: rows }, { records, planRead }] = await Promise.all([client.call("task.list", listArgs), planRecords(client, query, context.activeRoot)]);
  if (records.bets.length > 0) return undefined;
  const bets = [...sheetBets()].sort((a, b) => a.order - b.order);
  const active = await Promise.all(records.freezes.map((freeze) => freezeActive(client, freeze, query.today)));
  const plan: PlanView = { ...records, initiative: query.initiative, bets, freezes: records.freezes.filter((_, at) => active[at]) };
  const { tasks, unreadable } = parseTasks(rows);
  const result = evaluateEligibility(tasks, plan, await context.policyFor(tasks));
  return { result: { eligible: result.eligible, refused: [...result.refused, ...unreadable] }, planRead };
}
