import type { CostBucket, CostReport, WakeGapCell } from "./cost-report.js";
import { PRICE_TABLE_VERSION } from "./prices.js";

export const LIST_PRICE_CAVEAT =
  "List prices, not a bill: the accounts behind these sessions may run on subscription plans. Rankings hold; the absolute figure is not what you paid.";

type Cell = string | number;

/** The same report as plain-text tables, one section per report field, caveat and footer last. */
export function renderCostReportText(report: CostReport): string {
  const sections = [
    header(report),
    table("By token class", ["class", "tokens", "cost"], report.byTokenClass.map((row) => [row.tokenClass, row.tokens, usd(row.costUsd)])),
    bucketTable("By account", report.byAccount, report.totals.costUsd),
    bucketTable("By model", report.byModel, report.totals.costUsd),
    bucketTable("By class", report.byClass, report.totals.costUsd),
    bucketTable("By role", report.byRole, report.totals.costUsd),
    bucketTable("By initiative", report.byInitiative, report.totals.costUsd),
    bucketTable("By context band", report.byContextBand, report.totals.costUsd),
    wakeCauseTable(report),
    cellTable("Wake cause by gap band", report.wakeCauseByGapBand),
    cellTable(`Cold rebuilds: ${report.coldRebuild.requests} requests, ${usd(report.coldRebuild.costUsd)}`, report.coldRebuild.byGapBandAndCause),
    compactionTable(report.compactions),
    topSessionTable(report.topSessions),
    unpricedTable(report.unpricedModels),
    [LIST_PRICE_CAVEAT, footer(report)].join("\n"),
  ];
  return sections.join("\n\n") + "\n";
}

function header(report: CostReport): string {
  const { since, until } = report.window;
  const { requests, sessions, costUsd } = report.totals;
  return `Cost report, ${since ?? "beginning"} to ${until ?? "now"}\nTotal ${usd(costUsd)} over ${requests} requests in ${sessions} sessions`;
}

function bucketTable(title: string, buckets: readonly CostBucket[], total: number): string {
  const rows = buckets.map((b) => [b.key, b.requests, b.sessions, usd(b.costUsd), share(b.costUsd, total)]);
  return table(title, ["key", "requests", "sessions", "cost", "share"], rows);
}

/** Q4: answers sit under `human`, with typed text and answers indented one level down. */
function wakeCauseTable(report: CostReport): string {
  const rows = report.byWakeCause.flatMap((group) => [
    [group.key, group.requests, usd(group.costUsd), group.midLoopRequests, usd(group.midLoopCostUsd)],
    ...group.parts.map((part) => [`  ${part.key}`, part.requests, usd(part.costUsd), part.midLoopRequests, usd(part.midLoopCostUsd)]),
  ]);
  return table("By wake cause", ["cause", "requests", "cost", "mid-loop", "mid-loop cost"], rows);
}

function cellTable(title: string, cells: readonly WakeGapCell[]): string {
  return table(title, ["cause", "gap", "requests", "cost"], cells.map((c) => [c.wakeCause, c.gapBand, c.requests, usd(c.costUsd)]));
}

function compactionTable(c: CostReport["compactions"]): string {
  return table("Compactions", ["total", "manual", "auto", "mid-loop", "dropped tokens"], [[c.total, c.manual, c.auto, c.midLoop, c.droppedTokens]]);
}

function topSessionTable(sessions: CostReport["topSessions"]): string {
  const rows = sessions.map((s) => [s.sessionId, s.sessionClass, s.role, s.initiative, s.requests, usd(s.costUsd)]);
  return table("Top sessions", ["session", "class", "role", "initiative", "requests", "cost"], rows);
}

function unpricedTable(models: CostReport["unpricedModels"]): string {
  if (models.length === 0) return "Unpriced models: none";
  return table("Unpriced models (counted at zero cost)", ["model", "requests", "tokens"], models.map((m) => [m.model, m.requests, m.tokens]));
}

function footer(report: CostReport): string {
  const { transcriptsIndexed, transcriptsDiscovered, facetBacklog } = report.coverage;
  const discovered = transcriptsDiscovered === null ? "" : ` of ${transcriptsDiscovered} discovered`;
  const version = report.priceTableVersion === null ? "none" : `v${report.priceTableVersion}`;
  const stale = report.priceTableVersion !== null && report.priceTableVersion !== PRICE_TABLE_VERSION ? ` (package has v${PRICE_TABLE_VERSION})` : "";
  return `Price table ${version}${stale}. Coverage: ${transcriptsIndexed} transcripts indexed${discovered}, facet backlog ${facetBacklog}.`;
}

function table(title: string, head: readonly string[], rows: readonly (readonly Cell[])[]): string {
  if (rows.length === 0) return `${title}: none`;
  const text = [head, ...rows].map((row) => row.map(String));
  const widths = head.map((_, i) => Math.max(...text.map((row) => row[i]!.length)));
  const rightAligned = head.map((_, i) => rows.every((row) => isNumeric(row[i]!)));
  const pad = (cell: string, i: number) => (rightAligned[i] ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!));
  const lines = text.map((row) => row.map(pad).join("  ").trimEnd());
  return [title, ...lines].join("\n");
}

function isNumeric(cell: Cell): boolean {
  return typeof cell === "number" || /^\$|%$/.test(cell);
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function share(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "-";
}
