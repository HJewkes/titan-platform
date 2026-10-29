import type { WorkerReportRecord } from "./events-db.js";
import { frictionAgreement, logClusters, type AgentLog, type AgreementSummary, type LogClusterRow } from "./friction-agreement.js";
import { NON_FRICTION, extractFriction, lineCluster, type FrictionCluster, type FrictionSource } from "./friction-lines.js";

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

/** The secondary side: what workers said about themselves. */
export interface ReportSide {
  reports: number;
  /** Reports carrying the contract's `Friction:` field, the measure of CC-1660's adoption. */
  withFrictionField: number;
  /** Reports that said something through the fallback lines instead. */
  withFallback: number;
  /** Lines that were scope notes or design caveats: counted here, never ranked. */
  scopeNotes: number;
  clusters: FrictionClusterRow[];
}

/** The primary side: what the workers' own transcripts show. */
export interface LogSide {
  agents: number;
  sessions: number;
  clusters: LogClusterRow[];
}

export interface FrictionDailyReport {
  window: { since: string; until: string };
  logs: LogSide;
  reports: ReportSide;
  agreement: Omit<AgreementSummary, "rows">;
  rows: FrictionRow[];
  agreementRows: AgreementSummary["rows"];
  agentLogs: AgentLog[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const hours = (ms: number) => round2(ms / 3_600_000);

export function frictionRows(reports: readonly WorkerReportRecord[]): FrictionRow[] {
  return reports.map(({ body, ...report }) => ({
    ...report,
    agentHours: report.spawnedAt === null ? null : hours(Date.parse(report.at) - Date.parse(report.spawnedAt)),
    lines: extractFriction(body).map((line) => ({ ...line, cluster: lineCluster(line) })),
  }));
}

/** Clusters ranked by reports, then agent-hours, then name, so a tie always breaks the same way; scope notes are left out. */
export function reportSide(rows: readonly FrictionRow[]): ReportSide {
  const friction = (r: FrictionRow) => r.lines.filter((l) => !NON_FRICTION.has(l.cluster));
  const field = rows.filter((r) => r.lines.some((l) => l.source === "friction")).length;
  const fallback = rows.filter((r) => r.lines.length > 0).length - field;
  const clusters = [...new Set(rows.flatMap((r) => friction(r).map((l) => l.cluster)))].map((cluster) => clusterRow(cluster, rows));
  clusters.sort((a, b) => b.reports - a.reports || b.agentHours - a.agentHours || a.cluster.localeCompare(b.cluster));
  const scopeNotes = rows.reduce((n, r) => n + r.lines.length - friction(r).length, 0);
  return { reports: rows.length, withFrictionField: field, withFallback: fallback, scopeNotes, clusters };
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

/** Both sides of the day and how far they agree; the logs lead, since they are measured rather than recalled. */
export function frictionDailyReport(input: { reports: readonly WorkerReportRecord[]; logs: readonly AgentLog[]; window: { since: string; until: string } }): FrictionDailyReport {
  const rows = frictionRows(input.reports);
  const { rows: agreementRows, ...agreement } = frictionAgreement(input.logs, rows);
  const logs = { agents: input.logs.length, sessions: input.logs.reduce((n, l) => n + l.sessions.length, 0), clusters: logClusters(input.logs) };
  return { window: input.window, logs, reports: reportSide(rows), agreement, rows, agreementRows, agentLogs: [...input.logs] };
}
