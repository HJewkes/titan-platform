import { z } from "zod";
import { hasRefusedHead, latencyStats, latencyStatsSchema, mergeOutcomes, round, type LatencyStats, type MergeOutcome, type PullState, type VerdictRecord } from "./blocked-flow-merge.js";
import { dedupeDenials, type DenialRecord } from "./blocked-flow-denials.js";
import { TICK_HOLD_MAX_MIN, idleSlotMinutes, type SeatJournal } from "./blocked-flow-idle.js";
import { LIST_PRICE_CAVEAT, table } from "./render-text.js";

/** Where each section's numbers come from: the command that re-reads them and the field it reads. */
export const BLOCKED_FLOW_SOURCES = {
  verdicts: {
    command: `sqlite3 -readonly <events.db> "SELECT id, ts, target, body FROM events WHERE kind='message' AND body LIKE 'Verdict:%'"`,
    field: "events.ts, events.target, events.body lines Verdict:, PR:, Head:",
  },
  pulls: { command: "gh api repos/<owner>/<repo>/pulls/<n>", field: ".state, .merged_at, .head.sha" },
  denials: {
    command: "grep 'auto mode classifier. Reason: \\[' <seat transcript>.jsonl",
    field: "tool_result.content Reason: [<class>], joined to tool_use.input by tool_use_id",
  },
  journals: { command: "grep -nE 'impl [0-9]+/[0-9]+' <seat journal>.md", field: "impl <used>/<cap>, No dispatch: <reason>" },
} as const;

export type BlockedFlowSource = keyof typeof BLOCKED_FLOW_SOURCES;

export interface BlockedFlowInput {
  verdicts: readonly VerdictRecord[];
  /** Verdict messages the caller could not read with `parseVerdict`, already scoped to the window and seats. */
  unparsedVerdicts?: number;
  pulls: readonly PullState[];
  denials: readonly DenialRecord[];
  journals: readonly SeatJournal[];
  /** Waits are measured to here; a PR merged later counts as open. */
  asOf: string;
  window?: { since?: string; until?: string };
  /** Splits verdict-to-merge by verdict time, such as the moment a seat was granted merge authority. */
  splitAt?: string;
  /** Keeps only verdicts sent to, and denials and journals of, these seats. */
  seats?: readonly string[];
}

const source = z.enum(["verdicts", "pulls", "denials", "journals"]);
const count = z.number().int().nonnegative();

const latencyRowSchema = z.object({
  repo: z.string(),
  prs: count,
  staleHead: count,
  closed: count,
  unknown: count,
  all: latencyStatsSchema,
  before: latencyStatsSchema.optional(),
  after: latencyStatsSchema.optional(),
});

const openRowSchema = z.object({
  repo: z.string(),
  pr: count,
  head: z.string(),
  seat: z.string(),
  verdictAt: z.string(),
  ageMin: z.number(),
  eventId: count,
});

export const blockedFlowSchema = z.object({
  asOf: z.string(),
  window: z.object({ since: z.string().optional(), until: z.string().optional() }),
  splitAt: z.string().optional(),
  sources: z.record(source, z.object({ command: z.string(), field: z.string() })),
  verdictToMerge: z.object({ cites: z.array(source), rows: z.array(latencyRowSchema) }),
  refusedVerdicts: z.object({ cites: z.array(source), count }),
  openHoldingMerge: z.object({ cites: z.array(source), prMinutes: z.number(), rows: z.array(openRowSchema) }),
  denials: z.object({
    cites: z.array(source),
    total: count,
    rows: z.array(z.object({ reason: z.string(), action: z.string(), seat: z.string(), count })),
  }),
  idleSlots: z.object({
    cites: z.array(source),
    holdMaxMin: z.number(),
    total: z.number(),
    rows: z.array(z.object({ seat: z.string(), reason: z.string(), slotMinutes: z.number(), ticks: count, lines: z.array(count) })),
  }),
});

export type BlockedFlowReport = z.infer<typeof blockedFlowSchema>;
export type LatencyRow = z.infer<typeof latencyRowSchema>;

export const ALL_REPOS = "all";

/** Per repo: verdict-to-merge waits, PRs still holding MERGE, classifier denials and idle implementer slots. */
export function blockedFlowReport(input: BlockedFlowInput): BlockedFlowReport {
  const window = input.window ?? {};
  const inScope = scopeTest(input.seats, window);
  const scoped = input.verdicts.filter((v) => inScope(v.seat, v.at));
  const refused = scoped.filter(hasRefusedHead).length + (input.unparsedVerdicts ?? 0);
  const outcomes = mergeOutcomes(scoped.filter((v) => !hasRefusedHead(v)), input.pulls, input.asOf);
  const open = openRows(outcomes);
  const journals = input.journals.map((j) => ({ ...j, ticks: j.ticks.filter((t) => inScope(t.seat)) }));
  const idle = idleSlotMinutes(journals, window);
  return {
    asOf: input.asOf,
    window,
    ...(input.splitAt ? { splitAt: input.splitAt } : {}),
    sources: BLOCKED_FLOW_SOURCES,
    verdictToMerge: { cites: ["verdicts", "pulls"], rows: latencyRows(outcomes, input.splitAt) },
    refusedVerdicts: { cites: ["verdicts"], count: refused },
    openHoldingMerge: { cites: ["verdicts", "pulls"], prMinutes: round(open.reduce((sum, r) => sum + r.ageMin, 0)), rows: open },
    denials: denialSection(dedupeDenials(input.denials).filter((d) => inScope(d.seat, d.at))),
    idleSlots: { cites: ["journals"], holdMaxMin: TICK_HOLD_MAX_MIN, total: idle.reduce((sum, r) => sum + r.slotMinutes, 0), rows: idle },
  };
}

function scopeTest(seats: readonly string[] | undefined, window: { since?: string; until?: string }) {
  const named = seats ? new Set(seats) : null;
  return (seat: string, at?: string): boolean =>
    (!named || named.has(seat)) && (at === undefined || ((!window.since || at >= window.since) && (!window.until || at < window.until)));
}

function latencyRows(outcomes: readonly MergeOutcome[], splitAt: string | undefined): LatencyRow[] {
  const repos = [...new Set(outcomes.map((o) => o.repo))];
  const rows = repos.map((repo) => latencyRow(repo, outcomes.filter((o) => o.repo === repo), splitAt));
  return [...rows.sort((a, b) => b.prs - a.prs || a.repo.localeCompare(b.repo)), latencyRow(ALL_REPOS, outcomes, splitAt)];
}

function latencyRow(repo: string, outcomes: readonly MergeOutcome[], splitAt: string | undefined): LatencyRow {
  const status = (s: string) => outcomes.filter((o) => o.status === s).length;
  const row: LatencyRow = { repo, prs: outcomes.length, staleHead: status("stale-head"), closed: status("closed"), unknown: status("unknown"), all: latencyStats(outcomes) };
  if (!splitAt) return row;
  const timed = outcomes.filter((o) => o.verdict !== null);
  return { ...row, before: latencyStats(timed.filter((o) => o.verdict!.at < splitAt)), after: latencyStats(timed.filter((o) => o.verdict!.at >= splitAt)) };
}

function openRows(outcomes: readonly MergeOutcome[]): BlockedFlowReport["openHoldingMerge"]["rows"] {
  return outcomes
    .filter((o) => o.status === "open")
    .map((o) => ({ repo: o.repo, pr: o.pr, head: o.verdict!.head, seat: o.verdict!.seat, verdictAt: o.verdict!.at, ageMin: round(o.minutes!), eventId: o.verdict!.eventId }))
    .sort((a, b) => b.ageMin - a.ageMin);
}

function denialSection(denials: readonly DenialRecord[]): BlockedFlowReport["denials"] {
  const counts = new Map<string, { reason: string; action: string; seat: string; count: number }>();
  for (const d of denials) {
    const key = [d.reason, d.action, d.seat].join("\u0000");
    const row = counts.get(key) ?? { reason: d.reason, action: d.action, seat: d.seat, count: 0 };
    counts.set(key, { ...row, count: row.count + 1 });
  }
  const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason) || a.action.localeCompare(b.action));
  return { cites: ["denials"], total: denials.length, rows };
}

/** Each table's title names the JSON field its numbers come from; the sources close the report. */
export function renderBlockedFlowText(report: BlockedFlowReport): string {
  const scope = `Blocked flow as of ${report.asOf}${report.window.since ? `, since ${report.window.since}` : ""}${report.window.until ? `, until ${report.window.until}` : ""}`;
  const latency = [latencyTable("Verdict to merge, minutes from the first MERGE at the final head [verdictToMerge.rows[].all]", report.verdictToMerge.rows, "all")];
  if (report.splitAt) latency.push(...(["before", "after"] as const).map((part) => latencyTable(`Verdict to merge, verdicts ${part} ${report.splitAt} [verdictToMerge.rows[].${part}]`, report.verdictToMerge.rows, part)));
  return [scope, ...latency, openTable(report), refusedLine(report), denialTable(report), idleTable(report), sourceLines(report), LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

function latencyTable(title: string, rows: readonly LatencyRow[], part: "all" | "before" | "after"): string {
  const cells = rows.map((r) => [r.repo, r.prs, ...statCells(r[part]!), r.staleHead]);
  return table(title, ["repo", "prs", "merged", "median", "mean", "p90", "max", "open", "oldest open", "median incl. open", "stale head"], cells);
}

function statCells(s: LatencyStats): (string | number)[] {
  const n = (v: number | null) => (v === null ? "-" : v);
  return [s.merged, n(s.medianMin), n(s.meanMin), n(s.p90Min), n(s.maxMin), s.censored, n(s.oldestCensoredMin), n(s.medianWithCensoredMin)];
}

function openTable(report: BlockedFlowReport): string {
  const rows = report.openHoldingMerge.rows.map((r) => [r.repo, `#${r.pr}`, r.head.slice(0, 7), r.seat, r.verdictAt, r.ageMin, `events#${r.eventId}`]);
  const title = `Open PRs holding MERGE at their current head, ${report.openHoldingMerge.prMinutes} PR-minutes [openHoldingMerge.rows[].ageMin]`;
  return table(title, ["repo", "pr", "head", "seat", "verdict at", "age min", "verdict"], rows);
}

function refusedLine(report: BlockedFlowReport): string {
  return `Verdicts the merge gate would refuse (short or prefix head, URL-form PR, malformed block), counted in neither table above: ${report.refusedVerdicts.count} [refusedVerdicts.count]`;
}

function denialTable(report: BlockedFlowReport): string {
  const rows = report.denials.rows.map((r) => [r.reason, r.action, r.seat, r.count]);
  return table(`Classifier denials, ${report.denials.total} in all [denials.rows[].count]`, ["reason", "action", "seat", "count"], rows);
}

function idleTable(report: BlockedFlowReport): string {
  const rows = report.idleSlots.rows.map((r) => [r.seat, r.reason, r.slotMinutes, r.ticks, r.lines.join(",")]);
  const title = `Idle implementer slot-minutes by stated reason, ${report.idleSlots.total} in all, each tick held at most ${report.idleSlots.holdMaxMin} min [idleSlots.rows[].slotMinutes]`;
  return table(title, ["seat", "reason", "slot-min", "ticks", "journal lines"], rows);
}

function sourceLines(report: BlockedFlowReport): string {
  return ["Sources", ...Object.entries(report.sources).map(([name, s]) => `${name}: ${s.command} (${s.field})`)].join("\n");
}
