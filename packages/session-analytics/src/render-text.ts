import type { CostBucket, CostReport, MechanicalShare, RoleActions, WakeGapCell } from "./cost-report.js";
import type { HandoffThreshold } from "./handoff-threshold.js";
import { PRICE_TABLE_VERSION } from "./prices.js";
import type { WakeEpisodes } from "./wake-episodes.js";

export const LIST_PRICE_CAVEAT =
  "List prices, not a bill: the accounts behind these sessions may run on subscription plans. Rankings hold; the absolute figure is not what you paid.";

type Cell = string | number;

/** Wake causes and sender pairs the text shows; the JSON carries all of them. */
export const TOP_WAKE_ROWS = 10;

/** The same report as plain-text tables, one section per report field, caveat and footer last. */
export function renderCostReportText(report: CostReport): string {
  const sections = [
    header(report),
    table("By token class", ["class", "tokens", "cost"], report.byTokenClass.map((row) => [row.tokenClass, row.tokens, usd(row.costUsd)])),
    bucketTable("By account", report.byAccount, report.totals.costUsd),
    bucketTable("By model", report.byModel, report.totals.costUsd),
    bucketTable("By class", report.byClass, report.totals.costUsd),
    bucketTable("By role", report.byRole, report.totals.costUsd),
    actionTable(report.byAction),
    mechanicalTable(report.mechanicalShare),
    bucketTable("By episode count", report.byEpisodeCount, report.totals.costUsd),
    bucketTable("By initiative", report.byInitiative, report.totals.costUsd),
    bucketTable("By context band", report.byContextBand, report.totals.costUsd),
    wakeCauseTable(report),
    episodeTable(report.wakeEpisodes),
    pairTable(report.wakeEpisodes),
    handoffTable(report.handoffThreshold),
    teleportTable(report.handoffThreshold),
    reviewerTable(report.handoffThreshold),
    cellTable("Wake cause by gap band", report.wakeCauseByGapBand),
    cellTable(`Cold rebuilds: ${report.coldRebuild.requests} requests, ${usd(report.coldRebuild.costUsd)}`, report.coldRebuild.byGapBandAndCause),
    compactionTable(report.compactions),
    topSessionTable(report.topSessions),
    unpricedTable(report.unpricedModels),
    [LIST_PRICE_CAVEAT, footer(report)].join("\n"),
  ];
  return sections.join("\n\n") + "\n";
}

/** The report's sections a caller may render alone, keyed by the field each one shows. */
export const COST_REPORT_SECTIONS = {
  byRole: (report: CostReport) => bucketTable("By role", report.byRole, report.totals.costUsd),
  byAction: (report: CostReport) => actionTable(report.byAction),
  mechanicalShare: (report: CostReport) => mechanicalTable(report.mechanicalShare),
  byWakeCause: (report: CostReport) => wakeCauseTable(report),
  wakeEpisodes: (report: CostReport) => episodeTable(report.wakeEpisodes),
  wakePairs: (report: CostReport) => pairTable(report.wakeEpisodes),
  handoff: (report: CostReport) => handoffTable(report.handoffThreshold),
  teleports: (report: CostReport) => teleportTable(report.handoffThreshold),
  reviewers: (report: CostReport) => reviewerTable(report.handoffThreshold),
} as const;

export type CostReportSection = keyof typeof COST_REPORT_SECTIONS;

/** Some sections of the report under its header, with the caveat and footer last as in the full text. */
export function renderCostReportSections(report: CostReport, sections: readonly CostReportSection[]): string {
  const body = sections.map((section) => COST_REPORT_SECTIONS[section](report));
  return [header(report), ...body, [LIST_PRICE_CAVEAT, footer(report)].join("\n")].join("\n\n") + "\n";
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

/** Each role's row carries its total; its action classes sit indented beneath, sharing that total. */
function actionTable(roles: readonly RoleActions[]): string {
  const rows = roles.flatMap(({ role, buckets }) => {
    const total = buckets.reduce((sum, b) => sum + b.costUsd, 0);
    const requests = buckets.reduce((sum, b) => sum + b.requests, 0);
    return [[role, requests, usd(total), share(total, total)], ...buckets.map((b) => [`  ${b.key}`, b.requests, usd(b.costUsd), share(b.costUsd, total)])];
  });
  return table("By action per role", ["role / action", "requests", "cost", "share"], rows);
}

function mechanicalTable(m: MechanicalShare): string {
  const title = `Mechanical share: ${percent(m.share)} (${usd(m.costUsd)}) of total; classes ${m.classes.join(", ") || "none"}`;
  return table(title, ["role", "mechanical cost", "share of role"], m.byRole.map((r) => [r.role, usd(r.costUsd), percent(r.share)]));
}

/** Q4: answers sit under `human`, with typed text and answers indented one level down. */
function wakeCauseTable(report: CostReport): string {
  const rows = report.byWakeCause.flatMap((group) => [
    [group.key, group.requests, usd(group.costUsd), group.midLoopRequests, usd(group.midLoopCostUsd)],
    ...group.parts.map((part) => [`  ${part.key}`, part.requests, usd(part.costUsd), part.midLoopRequests, usd(part.midLoopCostUsd)]),
  ]);
  return table("By wake cause", ["cause", "requests", "cost", "mid-loop", "mid-loop cost"], rows);
}

/** Q4: the costliest causes per episode first, each with its senders indented beneath. */
function episodeTable(w: WakeEpisodes): string {
  const title = `Wake episodes of ${w.roles.join(", ")}: ${w.episodes} episodes, ${w.requests} requests, ${usd(w.costUsd)}; no-action means only ${w.noActionClasses.join(", ")}`;
  const causes = [...w.byCause].sort((a, b) => b.costPerEpisode - a.costPerEpisode || a.key.localeCompare(b.key)).slice(0, TOP_WAKE_ROWS);
  const rows = causes.flatMap((c) => [
    [c.key, c.episodes, c.midLoopEpisodes, c.requests, c.requestsPerEpisode.toFixed(1), usd(c.costUsd), usd(c.costPerEpisode), noActionCell(c)],
    ...c.byFrom.map((f) => [`  from ${f.key}`, f.episodes, "", f.requests, (f.requests / f.episodes).toFixed(1), usd(f.costUsd), usd(f.costUsd / f.episodes), noActionCell(f)]),
  ]);
  return table(title, ["cause", "episodes", "mid-loop", "requests", "req/ep", "cost", "cost/ep", "no-action"], rows);
}

function noActionCell(bucket: { episodes: number; noActionEpisodes: number }): string {
  return `${bucket.noActionEpisodes} (${share(bucket.noActionEpisodes, bucket.episodes)})`;
}

function pairTable(w: WakeEpisodes): string {
  const rows = w.pairs.slice(0, TOP_WAKE_ROWS).map((p) => [p.from, p.fromKind, p.to, p.episodes, p.requests, usd(p.costUsd), noActionCell(p)]);
  return table("Wake senders by receiver", ["from", "kind", "to", "episodes", "requests", "cost", "no-action"], rows);
}

/** Q2: per role and model, the fitted boot, fill and growth, the best K, and each configured K's extra cost per request. */
function handoffTable(h: HandoffThreshold): string {
  const title = `Handoff threshold per role, priced at package table v${PRICE_TABLE_VERSION}: best K over ${kilo(h.sweep.fromK)}-${kilo(h.sweep.toK)}, half-boot K in brackets`;
  const head = ["role", "model", "sessions", "boot", "boot fill", "growth/req", "read $/MTok", "best K", "$/req", ...h.configuredK.map((k) => `+$/req @${kilo(k)}`)];
  const rows = h.cohorts.map((c) => [
    c.role,
    c.model,
    c.sessions,
    usd(c.bootCostUsd),
    kilo(c.bootFill),
    Math.round(c.growthPerRequest),
    c.readPricePerMTok.toFixed(3),
    `${kiloOrDash(c.bestK)} (${kiloOrDash(c.halfBoot.bestK)})`,
    c.bestCostPerRequest === null ? "-" : `$${c.bestCostPerRequest.toFixed(4)}`,
    ...c.atConfigured.map((at) => (at.deltaPerRequest === null ? "-" : `$${at.deltaPerRequest.toFixed(4)}`)),
  ]);
  return table(title, head, rows);
}

function teleportTable(h: HandoffThreshold): string {
  const title = `Teleport exit fill: ${h.teleports.length} matched, ${h.unmatchedTeleports} unmatched; the latest ${TOP_WAKE_ROWS}`;
  const head = ["ts", "name", "role", "exit fill", "best K", ...h.configuredK.map((k) => `over ${kilo(k)}`)];
  const rows = h.teleports.slice(-TOP_WAKE_ROWS).map((t) => [t.ts, t.name ?? "-", t.role, kilo(t.exitFill), kiloOrDash(t.bestK), ...t.overConfigured.map((o) => kilo(o.over))]);
  return table(title, head, rows);
}

function reviewerTable(h: HandoffThreshold): string {
  const row = (kind: string) => (c: HandoffThreshold["reviewers"]["fresh"][number]) => [kind, c.role, c.model, c.sessions, c.requestsPerPr.toFixed(1), c.requestsFrom, usd(c.costUsd)];
  const rows = [...h.reviewers.fresh.map(row("fresh per PR")), ...h.reviewers.standing.map(row("standing"))];
  return table(`Reviewers over ${h.reviewers.prs} PRs, boot and reads: fresh per PR against one standing`, ["reviewer", "role", "model", "sessions", "req/PR", "req/PR from", "cost"], rows);
}

function kilo(tokens: number): string {
  return `${Math.round(tokens / 1_000)}k`;
}

function kiloOrDash(tokens: number | null): string {
  return tokens === null ? "-" : kilo(tokens);
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

export function table(title: string, head: readonly string[], rows: readonly (readonly Cell[])[]): string {
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

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function share(value: number, total: number): string {
  return total > 0 ? percent(value / total) : "-";
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
