import type { Command } from "commander";
import type { Verbs } from "../cli-types.js";
import { configPath, loadConfig, type FactoryConfig } from "../config.js";
import { EXIT } from "../exit-codes.js";
import { errorMessage } from "../narrow.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { isoWeek } from "../shepherd/stats.js";
import { readEligibility, readLaneTasks } from "./active-work.js";
import { admitLane, DEFAULT_LIMITS, filingFlow, holdsFor, type Admission, type BackPressureLimits, type Filing, type LaneSignals } from "./back-pressure.js";
import { laneComponents } from "./lane-components.js";
import { liveLaneSignals } from "./lane-signals.js";
import type { Eligibility } from "./rules.js";
import { registerShadowVerbs } from "./shadow/command.js";

interface EligibleOptions {
  initiative: string;
  week?: string;
  tag?: string;
  json?: boolean;
}

interface LaneReport {
  lane: { initiative: string; tag: string | null };
  /** The components a deploy stall or red main must hit to hold the lane; null when unmapped, which means every one. */
  dependsOn: readonly string[] | null;
  decision: Admission["decision"];
  holds: Admission["holds"];
  limits: BackPressureLimits;
  /** Every signal as a count, null where it was unread. */
  signals: Record<string, number | null>;
  /** The signals whose source could not be read; each also holds the lane or its gate-creating work. */
  unread: string[];
  filing: Filing;
  /** The task the dispatcher would take first, or null when the lane holds or no eligible task is free of holds. */
  next: string | null;
}

const ISO_WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

/** Each absent `shepherd.backPressure` key takes the owner's starting value. */
export function limitsOf(config: FactoryConfig): BackPressureLimits {
  const set = config.shepherd?.backPressure ?? {};
  return { laneOpenPrs: set.laneOpenPrs ?? DEFAULT_LIMITS.laneOpenPrs, ownerQueue: set.ownerQueue ?? DEFAULT_LIMITS.ownerQueue, inflowWeeks: set.inflowWeeks ?? DEFAULT_LIMITS.inflowWeeks };
}

/** Counts only, never repo names or causes, so the line is safe to paste into a public pull request. */
function signalCounts(signals: LaneSignals): LaneReport["signals"] {
  return {
    openPrs: signals.openPrs ?? null,
    mergedNotDeployed: signals.mergedNotDeployed ?? null,
    ownerQueue: signals.ownerQueue ?? null,
    reviewerAccounts: signals.reviewers?.accounts ?? null,
    reviewersExhausted: signals.reviewers?.exhausted ?? null,
    deployCauses: signals.deployStall?.length ?? null,
    redMainRepos: signals.redMain?.length ?? null,
  };
}

function refusalCounts(result: Eligibility): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { refusals } of result.refused) {
    for (const code of new Set(refusals.map((refusal) => refusal.code))) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

const heldCodes = (lane: Admission, entry: Eligibility["eligible"][number]): string[] => [...new Set(holdsFor(lane, entry.task.owner_steps).map((hold) => hold.code))];

function report(result: Eligibility, week: string, lane: LaneReport, admission: Admission): Record<string, unknown> {
  return {
    admission: lane,
    week,
    eligible: result.eligible.map((entry) => ({ id: entry.task.id, bet: entry.bet.id, class: entry.task.class ?? null, created: entry.task.created, held: heldCodes(admission, entry) })),
    refused: result.refused,
    counts: { eligible: result.eligible.length, refused: result.refused.length, byCode: refusalCounts(result) },
  };
}

function laneLines(lane: LaneReport): string[] {
  const name = lane.lane.tag === null ? lane.lane.initiative : `${lane.lane.initiative}/${lane.lane.tag}`;
  const codes = [...new Set(lane.holds.map((hold) => hold.code))];
  const flow = lane.filing.weeks.map((week) => `${week.week} in=${week.inflow} out=${week.outflow}`).join(", ");
  return [
    `lane ${name}: ${lane.decision}${codes.length ? ` (${codes.join(",")})` : ""}; next ${lane.next ?? "none"}`,
    `depends on ${lane.dependsOn?.join(",") ?? "everything (unmapped)"}`,
    `signals ${Object.entries(lane.signals).map(([key, n]) => `${key}=${n ?? "unread"}`).join(" ")} unread=${lane.unread.join(",") || "none"}`,
    ...lane.holds.map((hold) => `hold ${hold.code} ${hold.scope} ${Object.entries(hold.numbers).map(([key, n]) => `${key}=${n}`).join(" ")}${hold.detail ? `: ${hold.detail}` : ""}`),
    `filing ${lane.filing.paused ? "paused" : "open"}${flow ? ` (${flow})` : ""}`,
  ];
}

function text(result: Eligibility, week: string, lane: LaneReport, admission: Admission): string {
  const counts = Object.entries(refusalCounts(result)).map(([code, n]) => `${code}=${n}`);
  const lines = [...laneLines(lane), `week ${week}: ${result.eligible.length} eligible, ${result.refused.length} refused${counts.length ? ` (${counts.join(" ")})` : ""}`];
  for (const entry of result.eligible) {
    const held = heldCodes(admission, entry);
    lines.push(`eligible ${entry.task.id} ${entry.bet.id} ${entry.task.class ?? "-"} ${entry.task.created}${held.length ? ` held=${held.join(",")}` : ""}`);
  }
  for (const { id, refusals } of result.refused) lines.push(`refused ${id} ${refusals.map((refusal) => refusal.code).join(",")}`);
  return `${lines.join("\n")}\n`;
}

async function judge(opts: EligibleOptions, verbs: Verbs, query: { week: string; today: string }, now: number): Promise<string> {
  const source = { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) };
  const lane = { initiative: opts.initiative, ...(opts.tag !== undefined && { tag: opts.tag }) };
  const [result, laneTasks] = await Promise.all([readEligibility(source, { ...lane, ...query }), readLaneTasks(source, lane)]);
  const limits = limitsOf(loadConfig(configPath(verbs.io.env)));
  const signals = await (verbs.deps.laneSignals ?? liveLaneSignals(verbs))({ inLane: (key) => laneTasks.keys.has(key) });
  const components = laneComponents(lane);
  const admission = admitLane(signals, limits, components);
  const next = admission.decision === "admit" ? (result.eligible.find((entry) => heldCodes(admission, entry).length === 0)?.task.id ?? null) : null;
  const laneReport: LaneReport = {
    lane: { initiative: opts.initiative, tag: opts.tag ?? null },
    dependsOn: components ?? null,
    ...admission,
    limits,
    signals: signalCounts(signals),
    unread: Object.keys(signals.unread),
    filing: filingFlow(laneTasks.tasks, now, limits.inflowWeeks),
    next,
  };
  return opts.json ? `${JSON.stringify(report(result, query.week, laneReport, admission))}\n` : text(result, query.week, laneReport, admission);
}

async function run(opts: EligibleOptions, verbs: Verbs): Promise<number> {
  const { io } = verbs;
  if (opts.week !== undefined && !ISO_WEEK.test(opts.week)) {
    io.stderr("error: --week must be an ISO week such as 2026-W47\n");
    return EXIT.USAGE;
  }
  const now = new Date();
  const query = { week: opts.week ?? isoWeek(now.getTime()), today: now.toISOString().slice(0, 10) };
  try {
    io.stdout(await judge(opts, verbs, query, now.getTime()));
    return EXIT.OK;
  } catch (error) {
    io.stderr(`error: ${errorMessage(error)}\n`);
    return EXIT.UNAVAILABLE;
  }
}

/** `titan-factory dispatch eligible`: a read-only dry run of the selection policy and the lane's back-pressure over one initiative's tasks. */
export function registerDispatch(program: Command, verbs: Verbs): void {
  const dispatch = program.command("dispatch").description("the dispatcher's selection policy (PROPOSAL 2.2) and back-pressure (2.3)");
  dispatch
    .command("eligible")
    .description("whether the lane admits new work and why not, then the open tasks the dispatcher may take this week in dispatch order, and every refused task with its reason codes; reads only")
    .requiredOption("--initiative <slug>", "the initiative whose tasks and plan are read")
    .option("--week <YYYY-Www>", "the ISO week whose selected bets apply (default: this week, UTC)")
    .option("--tag <tag>", "only tasks carrying this tag (a lane, such as console)")
    .option("--json", "print { admission, week, eligible, refused, counts } as JSON")
    .action(async (opts: EligibleOptions) => verbs.setExit(await run(opts, verbs)));
  registerShadowVerbs(dispatch, verbs);
}
