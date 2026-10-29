import type { WorkerReportRecord } from "./events-db.js";
import { clusterOf, extractFriction, type FrictionCluster, type FrictionSource } from "./friction-lines.js";

/** One archived row per report in the window, friction or not, so the day's denominator survives too. */
export interface FrictionRow {
  eventId: number;
  at: string;
  agent: string;
  coordinator: string;
  spawnedAt: string | null;
  /** Spawn to report; null when the log has no spawn for the agent. */
  agentHours: number | null;
  lines: { source: FrictionSource; text: string; cluster: FrictionCluster }[];
}

export interface FrictionClusterRow {
  cluster: FrictionCluster;
  reports: number;
  /** Each agent counted once, at its longest spawn-to-report time in the cluster. */
  agentHours: number;
  agents: string[];
  sources: Partial<Record<FrictionSource, number>>;
  example: string;
}

export interface FrictionDailyReport {
  window: { since: string; until: string };
  reports: number;
  /** Reports carrying the contract's `Friction:` field, the measure of CC-1660's adoption. */
  withFrictionField: number;
  /** Reports that said something through the fallback lines instead. */
  withFallback: number;
  clusters: FrictionClusterRow[];
  rows: FrictionRow[];
}

export const FRICTION_TOP_N = 5;
export const FRICTION_ASKER = "friction-audit";
export const FRICTION_KEY = "friction-daily";

const HOUR_MS = 3_600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const hours = (ms: number) => round2(ms / HOUR_MS);

export function frictionRows(reports: readonly WorkerReportRecord[]): FrictionRow[] {
  return reports.map(({ body, ...report }) => ({
    ...report,
    agentHours: report.spawnedAt === null ? null : hours(Date.parse(report.at) - Date.parse(report.spawnedAt)),
    lines: extractFriction(body).map((line) => ({ ...line, cluster: clusterOf(line.text) })),
  }));
}

/** Clusters ranked by reports, then agent-hours, then name, so a tie always breaks the same way. */
export function frictionDailyReport(reports: readonly WorkerReportRecord[], window: { since: string; until: string }): FrictionDailyReport {
  const rows = frictionRows(reports);
  const field = rows.filter((r) => r.lines.some((l) => l.source === "friction")).length;
  const fallback = rows.filter((r) => r.lines.length > 0).length - field;
  const clusters = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.cluster)))].map((cluster) => clusterRow(cluster, rows));
  clusters.sort((a, b) => b.reports - a.reports || b.agentHours - a.agentHours || a.cluster.localeCompare(b.cluster));
  return { window, reports: rows.length, withFrictionField: field, withFallback: fallback, clusters, rows };
}

function clusterRow(cluster: FrictionCluster, rows: readonly FrictionRow[]): FrictionClusterRow {
  const hits = rows.flatMap((row) => row.lines.filter((l) => l.cluster === cluster).map((line) => ({ row, line })));
  const longest = new Map<string, number>();
  for (const { row } of hits) longest.set(row.agent, Math.max(longest.get(row.agent) ?? 0, row.agentHours ?? 0));
  const sources: Partial<Record<FrictionSource, number>> = {};
  for (const { line } of hits) sources[line.source] = (sources[line.source] ?? 0) + 1;
  return {
    cluster,
    reports: new Set(hits.map(({ row }) => row.eventId)).size,
    agentHours: round2([...longest.values()].reduce((sum, h) => sum + h, 0)),
    agents: [...longest.keys()],
    sources,
    example: hits[0]!.line.text,
  };
}

const sourceNote = (sources: FrictionClusterRow["sources"]) =>
  Object.entries(sources).map(([source, n]) => `${source} ${n}`).join(", ");

/** The top clusters, one line each, with two example agents and the first line that landed there. */
export function renderFrictionTop(report: FrictionDailyReport, top = FRICTION_TOP_N): string[] {
  return report.clusters.slice(0, top).map((c, i) =>
    `${i + 1}. ${c.cluster}: ${c.reports} of ${report.reports} reports, ${c.agentHours} agent-hours; e.g. ${c.agents.slice(0, 2).join(", ")} (${sourceNote(c.sources)}): "${c.example}"`,
  );
}

function headline(report: FrictionDailyReport): string {
  const fallback = report.withFallback > 0 ? `, ${report.withFallback} only through the Concerns:/Blocked fallback` : "";
  return `${report.reports} worker reports from ${report.window.since} to ${report.window.until}; ${report.withFrictionField} carry a Friction: line${fallback}.`;
}

export function renderFrictionMarkdown(report: FrictionDailyReport, date: string): string {
  const top = renderFrictionTop(report);
  return [`# Friction daily ${date}`, "", headline(report), "", ...(top.length > 0 ? top : ["No friction reported."]), ""].join("\n");
}

/** The day's know-item; it blocks nothing, so it has no `unblocksNow`. */
export function frictionDeposit(report: FrictionDailyReport, date: string, archive: string) {
  const lead = report.clusters[0];
  const summary = lead ? `Friction today: ${lead.cluster} (${lead.reports} of ${report.reports} reports)` : `Friction today: none reported (0 of ${report.reports} reports)`;
  const context = [headline(report), "", ...renderFrictionTop(report), "", `Raw rows: ${archive}`].join("\n");
  return { asker: FRICTION_ASKER, kind: "know" as const, door: "two-way" as const, depositId: frictionDepositId(date), summary, context, keys: [FRICTION_KEY] };
}

export const frictionDepositId = (date: string) => `${FRICTION_KEY}-${date}`;
