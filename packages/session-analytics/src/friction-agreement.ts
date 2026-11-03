import type { FrictionRow } from "./friction-daily.js";
import { NON_FRICTION, type FrictionCluster } from "./friction-lines.js";
import type { LogSignal, LogSignalKind } from "./transcript-friction.js";

/** One agent's log-derived friction in the window, over every session of it that was read. */
export interface AgentLog {
  agent: string;
  sessions: string[];
  signals: LogSignal[];
}

export interface LogClusterRow {
  cluster: FrictionCluster;
  agents: number;
  signals: number;
  /** The time the signals held workers, summed. */
  agentHours: number;
  kinds: Partial<Record<LogSignalKind, number>>;
  examples: string[];
}

export const AGREEMENTS = ["yes", "partial", "no", "n/a"] as const;
export type Agreement = (typeof AGREEMENTS)[number];

/** Does the agent's own report name the cluster its log says cost it most? */
export interface AgreementRow {
  agent: string;
  logTop: FrictionCluster | null;
  reported: FrictionCluster[];
  agreement: Agreement;
  logOnly: FrictionCluster[];
  reportOnly: FrictionCluster[];
}

export interface AgreementSummary {
  yes: number;
  partial: number;
  no: number;
  /** Agents with a report whose log showed no friction, so there is nothing to agree with. */
  notApplicable: number;
  /** Clusters by how many agents had them only in their log, or only in their report. */
  logOnly: { cluster: FrictionCluster; agents: number }[];
  reportOnly: { cluster: FrictionCluster; agents: number }[];
  rows: AgreementRow[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function hoursByCluster(signals: readonly LogSignal[]): Map<FrictionCluster, { hours: number; count: number }> {
  const totals = new Map<FrictionCluster, { hours: number; count: number }>();
  for (const s of signals) {
    const t = totals.get(s.cluster) ?? { hours: 0, count: 0 };
    totals.set(s.cluster, { hours: t.hours + s.hours, count: t.count + 1 });
  }
  return totals;
}

/** Ranked by agent-hours, then signals, then name: a log's cost is its time. */
export function logClusters(logs: readonly AgentLog[]): LogClusterRow[] {
  const rows = new Map<FrictionCluster, LogClusterRow>();
  for (const log of logs) {
    for (const [cluster, t] of hoursByCluster(log.signals)) {
      const row = rows.get(cluster) ?? { cluster, agents: 0, signals: 0, agentHours: 0, kinds: {}, examples: [] };
      row.agents += 1;
      row.signals += t.count;
      row.agentHours += t.hours;
      if (row.examples.length < 2) row.examples.push(log.agent);
      for (const s of log.signals.filter((x) => x.cluster === cluster)) row.kinds[s.kind] = (row.kinds[s.kind] ?? 0) + 1;
      rows.set(cluster, row);
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, agentHours: round2(r.agentHours) }))
    .sort((a, b) => b.agentHours - a.agentHours || b.signals - a.signals || a.cluster.localeCompare(b.cluster));
}

function topCluster(signals: readonly LogSignal[]): FrictionCluster | null {
  const ranked = [...hoursByCluster(signals)].sort(([a, x], [b, y]) => y.hours - x.hours || y.count - x.count || a.localeCompare(b));
  return ranked[0]?.[0] ?? null;
}

/** `other` names no cause a report could name, so agreement is judged on the named clusters alone. */
const named = (cluster: FrictionCluster) => cluster !== "other" && !NON_FRICTION.has(cluster);

function agreementRow(agent: string, signals: readonly LogSignal[], reports: readonly FrictionRow[]): AgreementRow {
  const namedSignals = signals.filter((s) => named(s.cluster));
  const logged = new Set(namedSignals.map((s) => s.cluster));
  const reported = [...new Set(reports.flatMap((r) => r.lines.map((l) => l.cluster)))].filter(named);
  const logTop = topCluster(namedSignals);
  const agreement: Agreement = logTop === null ? "n/a" : reported.includes(logTop) ? "yes" : reported.some((c) => logged.has(c)) ? "partial" : "no";
  return { agent, logTop, reported, agreement, logOnly: [...logged].filter((c) => !reported.includes(c)), reportOnly: reported.filter((c) => !logged.has(c)) };
}

function tallyClusters(rows: readonly AgreementRow[], pick: (row: AgreementRow) => FrictionCluster[]) {
  const counts = new Map<FrictionCluster, number>();
  for (const row of rows) for (const c of pick(row)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([cluster, agents]) => ({ cluster, agents })).sort((a, b) => b.agents - a.agents || a.cluster.localeCompare(b.cluster));
}

/** One row per agent that both reported and had a log read; an agent with no log stays out, since nothing was measured. */
export function frictionAgreement(logs: readonly AgentLog[], reports: readonly FrictionRow[]): AgreementSummary {
  const byAgent = new Map(logs.map((l) => [l.agent, l.signals]));
  const agents = [...new Set(reports.map((r) => r.agent))].filter((a) => byAgent.has(a)).sort();
  const rows = agents.map((a) => agreementRow(a, byAgent.get(a)!, reports.filter((r) => r.agent === a)));
  const count = (a: Agreement) => rows.filter((r) => r.agreement === a).length;
  const measured = rows.filter((r) => r.agreement !== "n/a");
  return {
    yes: count("yes"),
    partial: count("partial"),
    no: count("no"),
    notApplicable: count("n/a"),
    logOnly: tallyClusters(measured, (r) => r.logOnly),
    reportOnly: tallyClusters(measured, (r) => r.reportOnly),
    rows,
  };
}
