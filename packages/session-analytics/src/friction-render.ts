import type { FrictionDailyReport } from "./friction-daily.js";

export const FRICTION_TOP_N = 5;
export const FRICTION_ASKER = "friction-audit";
export const FRICTION_KEY = "friction-daily";

const counts = (record: Partial<Record<string, number>>) =>
  Object.entries(record).map(([key, n]) => `${key} ${n}`).join(", ");

/** The log-derived top clusters, the primary ranking, by agent-hours. */
export function renderLogTop(report: FrictionDailyReport, top = FRICTION_TOP_N): string[] {
  return report.logs.clusters.slice(0, top).map((c, i) =>
    `${i + 1}. ${c.cluster}: ${c.agentHours} agent-hours over ${c.agents} of ${report.logs.agents} agents, ${c.signals} signals (${counts(c.kinds)}); e.g. ${c.examples.join(", ")}`,
  );
}

/** The report-based top clusters, the secondary ranking, by reports. */
export function renderReportTop(report: FrictionDailyReport, top = FRICTION_TOP_N): string[] {
  const { reports } = report;
  return reports.clusters.slice(0, top).map((c, i) =>
    `${i + 1}. ${c.cluster}: ${c.reports} of ${reports.reports} reports, ${c.agentHours} agent-hours; e.g. ${c.agents.slice(0, 2).join(", ")} (${counts(c.sources)}): "${c.example}"`,
  );
}

const agreementRatio = ({ agreement: { yes, partial, no } }: FrictionDailyReport) => `self-report agreement ${yes}/${yes + partial + no}`;

function agreementLine(report: FrictionDailyReport): string {
  const { partial, no, notApplicable } = report.agreement;
  return `${agreementRatio(report)} (${partial} partial, ${no} no; ${notApplicable} with a quiet log)`;
}

function uniqueLines(report: FrictionDailyReport): string[] {
  const list = (rows: { cluster: string; agents: number }[]) => (rows.length > 0 ? rows.map((r) => `${r.cluster} ${r.agents}`).join(", ") : "nothing");
  return [`Only in logs: ${list(report.agreement.logOnly)}`, `Only in reports: ${list(report.agreement.reportOnly)}`];
}

function reportHeadline(report: FrictionDailyReport): string {
  const r = report.reports;
  return `${r.reports} worker reports; ${r.withFrictionField} carry a Friction: line, ${r.withFallback} only the Concerns:/Blocked fallback; ${r.scopeNotes} scope notes set aside as non-friction.`;
}

const orNone = (lines: string[]) => (lines.length > 0 ? lines : ["none"]);

/** Logs first, then agreement, then the reports; the context and the markdown summary share it. */
export function renderFrictionBody(report: FrictionDailyReport): string[] {
  return [
    `Window ${report.window.since} to ${report.window.until}. Logs: ${report.logs.sessions} sessions of ${report.logs.agents} agents.`,
    "",
    "Log-derived top 5 (agent-hours):",
    ...orNone(renderLogTop(report)),
    "",
    `${agreementLine(report)}.`,
    ...uniqueLines(report),
    "",
    reportHeadline(report),
    "Report-based top 5:",
    ...orNone(renderReportTop(report)),
  ];
}

export function renderFrictionMarkdown(report: FrictionDailyReport, date: string): string {
  return [`# Friction daily ${date}`, "", ...renderFrictionBody(report), ""].join("\n");
}

/** The day's know-item; it blocks nothing, so it has no `unblocksNow`. */
export function frictionDeposit(report: FrictionDailyReport, date: string, archive: string) {
  const lead = report.logs.clusters[0];
  const head = lead ? `Friction today: ${lead.cluster} (${lead.agentHours} agent-h, ${lead.agents} of ${report.logs.agents} agents)` : "Friction today: none in the logs";
  const summary = `${head}; ${agreementRatio(report)}`;
  const context = [...renderFrictionBody(report), "", `Raw rows: ${archive}`].join("\n");
  return { asker: FRICTION_ASKER, kind: "know" as const, door: "two-way" as const, depositId: frictionDepositId(date), summary, context, keys: [FRICTION_KEY] };
}

export const frictionDepositId = (date: string) => `${FRICTION_KEY}-${date}`;
