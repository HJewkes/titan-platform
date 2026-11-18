import type { Blocks } from "./blocks.js";
import { DASH, placeholder, pValue, ptsInterval, range, rate, table, usd } from "./format.js";
import type { Table } from "./tables.js";
import type { TrackReport } from "./track.js";

const TRACK_TITLE = { r: "Track R: review", i: "Track I: implement", p: "Track P: plan" } as const;

function armLabel(arm: string, side: boolean, n: number): string {
  return side ? `${arm} (shared blocks only, n ${n})` : arm;
}

function rateTable(view: Table): string {
  const secondary = Object.keys(view.rows[0]?.secondary ?? {});
  const header = ["arm", "n", `${view.primaryLabel} [95% CI]`, ...secondary, "by stratum"];
  const rows = view.rows.map((row) => [
    armLabel(row.arm, row.side, row.n),
    String(row.n),
    rate(row.primary),
    ...secondary.map((name) => rate(row.secondary[name])),
    Object.entries(row.byStratum).map(([label, cell]) => `${label} ${cell === null ? DASH : `${cell.successes}/${cell.n}`}`).join("; "),
  ]);
  return [`### ${view.title}`, "", table(header, rows)].join("\n");
}

function costTable(report: TrackReport): string {
  const header = ["arm", "n", "median $", "p90 $", "total $", "tokens", "seconds", `$ per ${report.successLabel} [95% CI]`];
  const rows = report.costs.map((cost) => [cost.arm, String(cost.n), usd(cost.usdMedian), usd(cost.usdP90), usd(cost.usdTotal), String(cost.tokens), String(cost.seconds), range(cost.costPerSuccess)]);
  return ["### Cost per arm", "", table(header, rows)].join("\n");
}

function comparisonTable(report: TrackReport): string {
  const header = ["table", "arm", "n", "Δ pts vs production [95% CI]", "McNemar p", "Holm p", "significant", "MDE (pts)"];
  const rows = report.tables.flatMap((view) =>
    view.comparisons.map((entry) => [
      view.id,
      entry.arm,
      String(entry.diff?.n ?? 0),
      entry.diff === null ? DASH : ptsInterval(entry.diff.delta, entry.diff.lower, entry.diff.upper),
      pValue(entry.diff?.p ?? null),
      pValue(entry.pHolm),
      entry.significant ? "yes" : "no",
      entry.mde === null ? DASH : `${(entry.mde * 100).toFixed(0)}`,
    ]),
  );
  return [`### Comparisons vs ${report.production}`, "", "Paired over cases, 10,000 bootstrap resamples, exact McNemar, Holm within the track.", "", table(header, rows)].join("\n");
}

function exclusions(blocks: Blocks): string {
  const counts = Object.entries(blocks.outcomeCounts).map(([outcome, count]) => `${outcome} ${count}`).join(", ");
  const excluded = blocks.excluded.map((job) => `- ${job.arm} on ${job.caseId} (block ${job.block}): ${job.outcome}`);
  const incomplete = blocks.incomplete.map((entry) => `- ${entry.caseId} (block ${entry.block}): ${entry.missing.map((miss) => `${miss.arm} ${miss.outcome}`).join(", ")}`);
  return [
    "### Excluded and incomplete",
    "",
    `Latest-attempt outcomes: ${counts || DASH}.`,
    "",
    `Excluded jobs (${excluded.length}):`,
    ...(excluded.length === 0 ? ["- none"] : excluded),
    "",
    `Incomplete blocks (${incomplete.length}), out of the paired tables:`,
    ...(incomplete.length === 0 ? ["- none"] : incomplete),
  ].join("\n");
}

function headline(report: TrackReport): string {
  const blocks = `${report.blocks.complete.length} complete blocks`;
  if (report.blocks.coreArms.includes(report.production)) return `Production arm ${report.production}; ${blocks}.`;
  return `Production arm ${report.production} has no jobs in this run, so nothing is compared; ${blocks} over the other arms.`;
}

export function trackSection(report: TrackReport, detail: string): string {
  return [
    `## ${TRACK_TITLE[report.track]}`,
    "",
    headline(report),
    "",
    ...report.tables.flatMap((view) => [rateTable(view), ""]),
    costTable(report),
    "",
    comparisonTable(report),
    "",
    detail,
    "",
    exclusions(report.blocks),
    "",
    placeholder(`${TRACK_TITLE[report.track]} narrative`),
  ].join("\n");
}
