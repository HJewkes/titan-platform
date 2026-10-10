import { RESOLVER_CLASSES } from "@titan-design/authority";
import type { GateRecord } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { stepOf } from "../coordinator-evidence.js";
import type { ShepherdEvent } from "./events.js";
import { overrideStats } from "./override-stats.js";
import { reviewCauseStats } from "./review-cause.js";
import { p90 } from "./stage-times.js";
import type { ReviewCostReport } from "./stats-cost.js";
import { redAfterMerge } from "./stats-quality.js";
import { inRange, mergedAt, mergeVerdictAt, payloadOf, shepherdStats, stepName, type StatsRange } from "./stats.js";
import { OVERDUE_HOURS, SEAT_STEPS } from "./waiting.js";

/** What every SLO query reads: the ledger, the clock, and a closed UTC day range. */
export interface SloInput {
  runs: readonly WorkflowRun[];
  gates: readonly GateRecord[];
  events: readonly ShepherdEvent[];
  now: number;
  range: { from: string; to: string };
  cost: (range: StatsRange) => Promise<ReviewCostReport>;
}

/** `value` is null when the window held nothing to measure, so an empty window never reads as a zero. */
export interface QueryValue {
  value: number | null;
  n: number;
}

type Query = (input: SloInput) => QueryValue | Promise<QueryValue>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const round = (value: number): number => Math.round(value * 1000) / 1000;
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const ratio = (part: number, whole: number): QueryValue => ({ value: whole === 0 ? null : round(part / whole), n: whole });
const count = (value: number, n: number): QueryValue => ({ value, n });
const daysIn = ({ from, to }: SloInput["range"]): number => (Date.parse(to) - Date.parse(from)) / DAY + 1;
const perDay = (events: number, range: SloInput["range"]): QueryValue => ({ value: round(events / daysIn(range)), n: daysIn(range) });

function percentile90(samples: readonly number[], unit: number): QueryValue {
  const sorted = samples.map((sample) => sample / unit).sort((a, b) => a - b);
  return { value: sorted.length === 0 ? null : round(p90(sorted)), n: sorted.length };
}

interface Step {
  name: string;
  at: number;
  result: Record<string, unknown>;
}

const stepsOf = (run: WorkflowRun): Step[] =>
  Object.entries(run.stepResults)
    .map(([key, result]) => ({ name: stepName(key), at: Date.parse(result.completedAt), result: payloadOf(result) }))
    .sort((a, b) => a.at - b.at);

const isDispatch = (step: Step): boolean => step.name === "sh-review" && step.result.kind === "dispatched";
const isVerdict = (step: Step): boolean => step.name === "sh-await-verdict" && step.result.kind === "verdict";
const isFixFirst = (step: Step): boolean => isVerdict(step) && step.result.verdict === "FIX_FIRST";

const stepsIn = ({ runs, range }: SloInput, name: string): Step[] => runs.flatMap((run) => stepsOf(run).filter((step) => step.name === name && inRange(step.at, range)));

function mergesIn({ runs, range }: SloInput): { run: WorkflowRun; at: number }[] {
  return runs.flatMap((run) => {
    const at = mergedAt(run);
    return at !== undefined && inRange(at, range) ? [{ run, at }] : [];
  });
}

const isOwner = (gate: GateRecord): boolean => gate.resolvedBy !== undefined && (RESOLVER_CLASSES as readonly string[]).includes(gate.resolvedBy.class);
const resolvedIn = ({ gates, range }: SloInput): GateRecord[] => gates.filter((gate) => gate.status === "resolved" && gate.resolvedAt !== undefined && inRange(Date.parse(gate.resolvedAt), range));
const hoursOpen = (gate: GateRecord): number => (Date.parse(gate.resolvedAt!) - Date.parse(gate.createdAt)) / HOUR;

/** Pairs each opening event with the next closing one under the same key; an episode still open runs to `now`. */
function episodes(events: readonly ShepherdEvent[], keyOf: (event: ShepherdEvent) => string | null, open: ShepherdEvent["kind"], close: ShepherdEvent["kind"], now: number) {
  const started = new Map<string, number>();
  const closed: { end: number; hours: number }[] = [];
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = keyOf(event);
    const at = Date.parse(event.at);
    if (key === null) continue;
    if (event.kind === open && !started.has(key)) started.set(key, at);
    if (event.kind === close && started.has(key)) closed.push({ end: at, hours: (at - started.get(key)!) / HOUR });
    if (event.kind === close) started.delete(key);
  }
  return [...closed, ...[...started.values()].map((start) => ({ end: now, hours: (now - start) / HOUR }))];
}

/** Review causes with `unknown` left out: most of the ledger predates recorded causes, and those reviews would read as re-reviews. */
function knownCauses(runs: readonly WorkflowRun[], range: StatsRange) {
  return reviewCauseStats(runs, range).map(({ causes: { unknown = 0, ...causes }, reviews }) => ({ reviews: reviews - unknown, causes }));
}

/** Each review dispatch paired with the verdict that answered it. */
function reviewWaits(run: WorkflowRun): { at: number; ms: number }[] {
  let dispatched: number | undefined;
  const waits: { at: number; ms: number }[] = [];
  for (const step of stepsOf(run)) {
    if (isDispatch(step)) dispatched = step.at;
    else if (isVerdict(step) && dispatched !== undefined) {
      waits.push({ at: step.at, ms: step.at - dispatched });
      dispatched = undefined;
    }
  }
  return waits;
}

const availability: Record<string, Query> = {
  "availability.stuck-runs": ({ runs, gates }) => {
    const gated = new Set(gates.filter((gate) => gate.status === "pending").map((gate) => gate.id.slice(0, gate.id.indexOf("/"))));
    return count(runs.filter((run) => run.status === "recovery_required" || (run.status === "paused" && !gated.has(run.id))).length, runs.length);
  },
  "availability.failed-share": ({ runs, range }) => {
    const started = runs.filter((run) => inRange(Date.parse(run.startedAt), range));
    return ratio(started.filter((run) => run.status === "failed").length, started.length);
  },
  "availability.freeze-hours-max": ({ events, now, range }) => {
    const frozen = episodes(events, (event) => (event.runId === null ? event.repo : null), "freeze", "thaw", now).filter((episode) => inRange(episode.end, range));
    return count(round(Math.max(0, ...frozen.map((episode) => episode.hours))), frozen.length);
  },
};

const flow: Record<string, Query> = {
  "flow.queued-p90": ({ runs, range }) =>
    percentile90(
      runs.flatMap((run) => {
        const first = stepsOf(run).find(isDispatch)?.at;
        return first !== undefined && inRange(first, range) ? [first - Date.parse(run.startedAt)] : [];
      }),
      MINUTE,
    ),
  "flow.review-p90": ({ runs, range }) => percentile90(runs.flatMap((run) => reviewWaits(run).filter((wait) => inRange(wait.at, range)).map((wait) => wait.ms)), MINUTE),
  "flow.rereviews-per-first-review": ({ runs, range }) => {
    const rows = knownCauses(runs, range);
    const firsts = sum(rows.map((row) => row.causes.first ?? 0));
    return ratio(sum(rows.map((row) => row.reviews)) - firsts, firsts);
  },
  "flow.hold-p90-hours": ({ events, now, range }) => percentile90(episodes(events, (event) => event.runId, "hold", "release", now).filter((hold) => inRange(hold.end, range)).map((hold) => hold.hours), 1),
  "flow.merge-gate-wait-p90": (input) => percentile90(resolvedIn(input).filter((gate) => stepOf(gate.id) === "approve-merge").map(hoursOpen), 1),
  "flow.merge-verdict-to-merged-p90": (input) =>
    percentile90(
      mergesIn(input).flatMap(({ run, at }) => {
        const verdict = mergeVerdictAt(run, at);
        return verdict === undefined ? [] : [at - verdict];
      }),
      MINUTE,
    ),
  "flow.register-to-merged-p90": (input) => percentile90(mergesIn(input).map(({ run, at }) => at - Date.parse(run.startedAt)), MINUTE),
  "flow.outside-share": ({ runs, range }) => {
    const rows = shepherdStats(runs, range);
    return ratio(sum(rows.map((row) => row.outsideMerges)), sum(rows.map((row) => row.merges + row.outsideMerges)));
  },
  "flow.merge-ups-per-merge": (input) => {
    const merges = mergesIn(input);
    return ratio(sum(merges.map(({ run }) => stepsOf(run).filter((step) => step.name === "update-branch").length)), merges.length);
  },
};

const quality: Record<string, Query> = {
  "quality.fix-first-rate": (input) => {
    const verdicts = stepsIn(input, "sh-await-verdict").filter(isVerdict);
    return ratio(verdicts.filter(isFixFirst).length, verdicts.length);
  },
  "quality.red-after-merge-rate": ({ runs, range }) => {
    const rows = redAfterMerge(runs, range);
    return ratio(sum(rows.map((row) => row.red)), sum(rows.map((row) => row.merged)));
  },
  "quality.reverts": ({ runs, range }) => {
    const rows = redAfterMerge(runs, range);
    return count(sum(rows.map((row) => row.reverted)), sum(rows.map((row) => row.merged)));
  },
  "quality.override-rate": ({ runs, range }) => {
    const rows = overrideStats(runs, range);
    return ratio(sum(rows.map((row) => row.overrides)), sum(rows.map((row) => row.mergeRuns)));
  },
  "quality.no-verdict-rate": (input) => {
    const waits = stepsIn(input, "sh-await-verdict");
    return ratio(waits.filter((step) => step.result.kind === "none").length, waits.length);
  },
  "quality.fix-rounds-p90": (input) => percentile90(mergesIn(input).map(({ run }) => stepsOf(run).filter(isFixFirst).length), 1),
};

const ownerLoad: Record<string, Query> = {
  "owner-load.overdue-owner-gates": ({ gates, now }) => {
    const pending = gates.filter((gate) => gate.status === "pending" && !SEAT_STEPS.includes(stepOf(gate.id)));
    return count(pending.filter((gate) => (now - Date.parse(gate.createdAt)) / HOUR > OVERDUE_HOURS).length, pending.length);
  },
  "owner-load.touches-per-day": (input) => perDay(resolvedIn(input).filter(isOwner).length, input.range),
  "owner-load.gate-wait-p90": (input) => percentile90(resolvedIn(input).filter(isOwner).map(hoursOpen), 1),
  "owner-load.cancelled-gate-share": ({ gates, range }) => {
    const opened = gates.filter((gate) => inRange(Date.parse(gate.createdAt), range));
    return ratio(opened.filter((gate) => gate.status === "cancelled").length, opened.length);
  },
  "owner-load.delegation-share": (input) => {
    const answered = resolvedIn(input).filter((gate) => gate.resolvedBy !== undefined);
    return ratio(answered.filter((gate) => !isOwner(gate)).length, answered.length);
  },
};

/** Only PRs whose every round was read count, so an unreadable transcript never lowers the mean. */
async function completeCosts({ cost, range }: SloInput) {
  return (await cost(range)).prs.filter((pr) => pr.unreadable.length === 0);
}

const cost: Record<string, Query> = {
  "cost.reviewer-usd-per-merge": async (input) => {
    const prs = await completeCosts(input);
    return ratio(sum(prs.map((pr) => pr.usd)), prs.length);
  },
  "cost.reviewer-tokens-per-merge": async (input) => {
    const prs = await completeCosts(input);
    return ratio(sum(prs.map(({ tokens }) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output)), prs.length);
  },
  "cost.reviews-per-merge": (input) => ratio(stepsIn(input, "sh-review").filter(isDispatch).length, mergesIn(input).length),
  "cost.superseded-review-share": ({ runs, range }) => {
    const rows = knownCauses(runs, range);
    return ratio(sum(rows.map((row) => row.causes.superseded ?? 0)), sum(rows.map((row) => row.reviews)));
  },
};

const business: Record<string, Query> = {
  "business.merges-per-day": (input) => perDay(mergesIn(input).length, input.range),
  "business.unattended-share": (input) => {
    const touched = new Set(input.gates.filter((gate) => gate.status === "resolved" && isOwner(gate)).map((gate) => gate.id.slice(0, gate.id.indexOf("/"))));
    const merges = mergesIn(input);
    return ratio(merges.filter(({ run }) => !touched.has(run.id)).length, merges.length);
  },
};

/** The queries `shepherd stats --slo` can run, by the id a `metrics/shepherd.yml` query names in its `text`. */
export const SLO_QUERIES: Readonly<Record<string, Query>> = { ...availability, ...flow, ...quality, ...ownerLoad, ...cost, ...business };
