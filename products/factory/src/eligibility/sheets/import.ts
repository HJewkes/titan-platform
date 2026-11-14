import { createRpcClient, liveSource, RpcError, type LiveSourceOptions } from "@titan-design/rpc-client";
import { z } from "zod";
import type { BetSheet, SheetBet } from "./bet-sheet.js";

/*
 * The sheet importer (TP-5755 S7): a sheet becomes a draft outcome and proposed bets, written by active-work's own
 * `plan.outcome.add` and `plan.bet.add`. Those are the only commands it can call; selecting a bet is the owner's console
 * operation and has no path from here.
 */

interface OutcomeArgs {
  initiative: string;
  slug: string;
  statement: string;
  measure: string;
  intent_ref?: string;
  quote_ref?: string;
}

interface BetArgs {
  initiative: string;
  week: string;
  outcome: string;
  order: number;
  task?: string[];
  selector?: string;
  metric: string;
  direction: "increase" | "decrease";
  baseline: number;
  expected: number;
  read_by: string;
}

/** The whole write surface: two adds, each answered with the record the daemon wrote. */
type ImportCommands = {
  "plan.outcome.add": { args: OutcomeArgs; result: unknown };
  "plan.bet.add": { args: BetArgs; result: unknown };
};

export type ImportCall = { command: "plan.outcome.add"; args: OutcomeArgs } | { command: "plan.bet.add"; args: BetArgs };

interface ImportPlan {
  calls: ImportCall[];
  /** Bets the daemon would refuse as written; a plan with any is not applied. */
  problems: string[];
}

function outcomeCall(sheet: BetSheet): ImportCall {
  const { outcome, front } = sheet;
  const intent = outcome.owner_intent === undefined ? {} : { intent_ref: outcome.owner_intent.intent_ref, quote_ref: outcome.owner_intent.quote_ref };
  return { command: "plan.outcome.add", args: { initiative: front.initiative, slug: outcome.local, statement: outcome.statement, measure: outcome.measure, ...intent } };
}

function betCall(sheet: BetSheet, bet: SheetBet, baseline: number): ImportCall {
  const { metric, direction, expected, read_by } = bet.prediction;
  const named = { ...(bet.tasks !== undefined && { task: bet.tasks }), ...(bet.selector !== undefined && { selector: bet.selector }) };
  const args: BetArgs = { initiative: sheet.front.initiative, week: sheet.front.week, outcome: sheet.outcome.id, order: bet.order, ...named, metric, direction, baseline, expected, read_by };
  return { command: "plan.bet.add", args };
}

/** The calls that would write one sheet, outcome first since each bet names it. */
export function importPlan(sheet: BetSheet): ImportPlan {
  const calls: ImportCall[] = [outcomeCall(sheet)];
  const problems: string[] = [];
  for (const bet of sheet.bets) {
    if (bet.prediction.baseline === null) problems.push(`bet ${bet.local}: plan.bet.add needs a numeric baseline, and the sheet's is null`);
    else calls.push(betCall(sheet, bet, bet.prediction.baseline));
  }
  return { calls, problems };
}

/** A daemon built before the plan commands answers this way; the importer then stops rather than write plan files itself. */
export class PlanCommandsMissing extends Error {}

const unknownCommand = (error: unknown): boolean => error instanceof RpcError && error.message.startsWith("Unknown command");

type ListCommands = {
  "plan.outcome.list": { args: { initiative: string }; result: unknown };
  "plan.bet.list": { args: { initiative: string; week: string; state: "proposed" | "selected" }; result: unknown };
};

/** Reads before writing so a re-run, or a run after a partial one, adds only what the plan store lacks. */
async function existingKeys(client: ReturnType<typeof createRpcClient<ImportCommands & ListCommands>>, calls: readonly ImportCall[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const outcomeInitiatives = new Set<string>();
  const betWeeks = new Map<string, { initiative: string; week: string }>();
  for (const call of calls) {
    if (call.command === "plan.outcome.add") outcomeInitiatives.add(call.args.initiative);
    else betWeeks.set(`${call.args.initiative} ${call.args.week}`, { initiative: call.args.initiative, week: call.args.week });
  }
  for (const initiative of outcomeInitiatives) {
    const rows = z.array(z.object({ id: z.string() })).parse(await client.call("plan.outcome.list", { initiative }));
    for (const row of rows) keys.add(`outcome ${row.id}`);
  }
  for (const { initiative, week } of betWeeks.values()) {
    for (const state of ["proposed", "selected"] as const) {
      const rows = z.array(z.object({ outcome: z.string(), order: z.number() })).parse(await client.call("plan.bet.list", { initiative, week, state }));
      for (const row of rows) keys.add(`bet ${week} ${row.outcome} ${row.order}`);
    }
  }
  return keys;
}

function callKey(call: ImportCall): string {
  if (call.command === "plan.outcome.add") return `outcome ${call.args.initiative}/${call.args.slug}`;
  return `bet ${call.args.week} ${call.args.outcome} ${call.args.order}`;
}

export interface ImportOutcome {
  written: number;
  skipped: number;
}

/** Runs each call the plan store does not already hold, in order, stopping at the first failure. */
export async function applyImport(source: LiveSourceOptions, calls: readonly ImportCall[]): Promise<ImportOutcome> {
  const client = createRpcClient<ImportCommands & ListCommands>(liveSource(source));
  let written = 0;
  try {
    const existing = await existingKeys(client, calls);
    for (const call of calls) {
      if (existing.has(callKey(call))) continue;
      if (call.command === "plan.outcome.add") await client.call("plan.outcome.add", call.args);
      else await client.call("plan.bet.add", call.args);
      written += 1;
    }
  } catch (error) {
    if (unknownCommand(error)) throw new PlanCommandsMissing(`active-work has no ${calls[written]?.command ?? "plan.outcome.add"} command; update and restart the active-work daemon, then import again`);
    throw error;
  }
  return { written, skipped: calls.length - written };
}
