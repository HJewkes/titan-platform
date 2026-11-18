import { TaskSchema, type Bet, type Task } from "@titan-design/pm";
import { createRpcClient, liveSource, type LiveSourceOptions } from "@titan-design/rpc-client";
import { z } from "zod";
import { freezeActive, readPlanRecords, type EligibilityCommands, type EligibilityQuery, type PlanReadSource } from "../active-work.js";
import type { SelectionPolicy } from "../intake.js";
import { evaluateEligibility, type Eligibility, type PlanView, type RefusedTask } from "../rules.js";

/*
 * The plan read for a lane that may fall back to its bet sheet (TP-5755 S7). It reads the plan through active-work.ts,
 * but swaps in the sheet's proposed bets when the store holds no selected bet for the week.
 */

export type SheetQuery = EligibilityQuery;

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
): Promise<{ result: Eligibility; planRead: PlanReadSource } | undefined> {
  const client = createRpcClient<EligibilityCommands>(liveSource(source));
  const listArgs = { slug: query.initiative, status: "open" as const, ...(query.tag !== undefined && { tag: query.tag }) };
  const [{ tasks: rows }, { records, planRead }] = await Promise.all([client.call("task.list", listArgs), readPlanRecords(client, query, context.activeRoot)]);
  if (records.bets.length > 0) return undefined;
  const bets = [...sheetBets()].sort((a, b) => a.order - b.order);
  const active = await Promise.all(records.freezes.map((freeze) => freezeActive(client, freeze, query.today)));
  const plan: PlanView = { ...records, initiative: query.initiative, bets, freezes: records.freezes.filter((_, at) => active[at]) };
  const { tasks, unreadable } = parseTasks(rows);
  const result = evaluateEligibility(tasks, plan, await context.policyFor(tasks));
  return { result: { eligible: result.eligible, refused: [...result.refused, ...unreadable] }, planRead };
}
