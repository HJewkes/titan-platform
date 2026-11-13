import type { Command } from "commander";
import type { Verbs } from "../cli-types.js";
import { EXIT } from "../exit-codes.js";
import { errorMessage } from "../narrow.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { isoWeek } from "../shepherd/stats.js";
import { readEligibility } from "./active-work.js";
import type { Eligibility } from "./rules.js";

interface EligibleOptions {
  initiative: string;
  week?: string;
  tag?: string;
  json?: boolean;
}

const ISO_WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

function refusalCounts(result: Eligibility): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { refusals } of result.refused) {
    for (const code of new Set(refusals.map((refusal) => refusal.code))) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function report(result: Eligibility, week: string): Record<string, unknown> {
  return {
    week,
    eligible: result.eligible.map(({ task, bet }) => ({ id: task.id, bet: bet.id, class: task.class ?? null, created: task.created })),
    refused: result.refused,
    counts: { eligible: result.eligible.length, refused: result.refused.length, byCode: refusalCounts(result) },
  };
}

function text(result: Eligibility, week: string): string {
  const counts = Object.entries(refusalCounts(result)).map(([code, n]) => `${code}=${n}`);
  const lines = [`week ${week}: ${result.eligible.length} eligible, ${result.refused.length} refused${counts.length ? ` (${counts.join(" ")})` : ""}`];
  for (const { task, bet } of result.eligible) lines.push(`eligible ${task.id} ${bet.id} ${task.class ?? "-"} ${task.created}`);
  for (const { id, refusals } of result.refused) lines.push(`refused ${id} ${refusals.map((refusal) => refusal.code).join(",")}`);
  return `${lines.join("\n")}\n`;
}

async function run(opts: EligibleOptions, verbs: Verbs): Promise<number> {
  const { io, deps } = verbs;
  if (opts.week !== undefined && !ISO_WEEK.test(opts.week)) {
    io.stderr("error: --week must be an ISO week such as 2026-W47\n");
    return EXIT.USAGE;
  }
  const now = new Date();
  const week = opts.week ?? isoWeek(now.getTime());
  const query = { initiative: opts.initiative, week, today: now.toISOString().slice(0, 10), ...(opts.tag !== undefined && { tag: opts.tag }) };
  try {
    const result = await readEligibility({ origin: activeWorkOrigin(io.env), ...(deps.fetch && { fetch: deps.fetch }) }, query);
    io.stdout(opts.json ? `${JSON.stringify(report(result, week))}\n` : text(result, week));
    return EXIT.OK;
  } catch (error) {
    io.stderr(`error: ${errorMessage(error)}\n`);
    return EXIT.UNAVAILABLE;
  }
}

/** `titan-factory dispatch eligible`: a read-only dry run of the selection policy over one initiative's open tasks. */
export function registerDispatch(program: Command, verbs: Verbs): void {
  const dispatch = program.command("dispatch").description("the dispatcher's selection policy (PROPOSAL 2.2)");
  dispatch
    .command("eligible")
    .description("list the open tasks the dispatcher may take this week, in dispatch order, and every refused task with its reason codes; reads only")
    .requiredOption("--initiative <slug>", "the initiative whose tasks and plan are read")
    .option("--week <YYYY-Www>", "the ISO week whose selected bets apply (default: this week, UTC)")
    .option("--tag <tag>", "only tasks carrying this tag (a lane, such as console)")
    .option("--json", "print { week, eligible, refused, counts } as JSON")
    .action(async (opts: EligibleOptions) => verbs.setExit(await run(opts, verbs)));
}
