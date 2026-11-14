import { DASH, placeholder, ptsInterval, table, usd } from "./format.js";
import { implementDetail, planDetail, reviewDetail } from "./markdown-detail.js";
import { trackSection } from "./markdown-track.js";
import type { Report } from "./report.js";
import type { RoutingRow } from "./routing.js";

type Pick = RoutingRow["review"];

const TRACKS = ["r", "i", "p"] as const;

function partialBanner(report: Report): string[] {
  if (!report.partial) return [];
  const blocks = TRACKS.map((track) => {
    const target = report.targets[track];
    return `${track.toUpperCase()} ${report.completeBlocks[track] ?? 0}${target === undefined ? "" : ` of ${target}`}`;
  }).join(" / ");
  return [`> **PARTIAL.** Complete blocks per track: ${blocks}.`, ""];
}

function blocksTable(report: Report): string {
  const rows = TRACKS.map((track) => {
    const blocks = report.tracks[track]?.blocks;
    if (blocks === undefined) return [track.toUpperCase(), "not run", DASH, DASH, DASH, DASH, DASH];
    const counts = [blocks.complete.length, blocks.incomplete.length, blocks.excluded.length].map(String);
    return [track.toUpperCase(), blocks.production, blocks.coreArms.join(", "), blocks.sideArms.join(", ") || DASH, ...counts];
  });
  return table(["track", "production", "arms in complete blocks", "arms on shared blocks only", "complete blocks", "incomplete blocks", "excluded jobs"], rows);
}

const pickText = (pick: Pick): string => pick?.text ?? DASH;

function evidence(label: string, pick: Pick): string[] {
  if (pick === null || pick.n === 0) return [];
  return [`${label} n ${pick.n}, Δ ${ptsInterval(pick.delta, pick.lower, pick.upper)}`];
}

function routingSection(report: Report): string {
  const rows = report.routing.map((row) => [
    `${row.kind} × ${row.size}`,
    pickText(row.review),
    pickText(row.implement),
    pickText(row.plan),
    [...evidence("R", row.review), ...evidence("I", row.implement), ...evidence("P", row.plan)].join("; ") || DASH,
  ]);
  const { minRoutingBlocks, maxRoutingHalfWidth, margins } = report.rules;
  const rule = `Pick: the cheapest arm whose paired CI against the best arm stays within ${margins.review * 100} pts (R), ${margins.implement * 100} pts (I) or ${margins.plan} win-score (P). Under ${minRoutingBlocks} complete blocks or a CI wider than ±${maxRoutingHalfWidth * 100} pts: too thin, keep production.`;
  return ["## Routing table", "", rule, "", table(["kind × size", "review pick", "implement pick", "plan pick", "evidence (n blocks, Δ pts vs production, CI)"], rows), "", placeholder("routing recommendations")].join("\n");
}

function costSection(report: Report): string {
  const rows = TRACKS.flatMap((track) => {
    if (report.tracks[track] === undefined) return [];
    const arm = report.cost.arm[track] ?? 0;
    const judge = report.cost.judge[track] ?? 0;
    return [[track.toUpperCase(), usd(arm), usd(judge), usd(arm + judge)]];
  });
  const { totals } = report.cost;
  return ["## Cost ledgers", "", "Arm cost is every job row, retries and excluded jobs included; judge overhead is kept apart.", "", table(["track", "arm $", "judge overhead $", "total $"], [...rows, ["all", usd(totals.arm), usd(totals.judge), usd(totals.all)]])].join("\n");
}

export function renderReport(report: Report): string {
  const { r, i, p } = report.tracks;
  const sections = [
    r === undefined ? undefined : trackSection(r, reviewDetail(r.extra)),
    i === undefined ? undefined : trackSection(i, implementDetail(i.extra)),
    p === undefined ? undefined : trackSection(p, planDetail(p.extra)),
  ].flatMap((section) => (section === undefined ? [] : [section, ""]));
  return [
    "# Model-routing benchmark report",
    "",
    ...partialBanner(report),
    placeholder("verdict and narrative"),
    "",
    "## Runs and blocks",
    "",
    blocksTable(report),
    "",
    ...sections,
    routingSection(report),
    "",
    costSection(report),
    "",
    "## Charts",
    "",
    placeholder("rate-vs-cost charts per track, from report.json tracks.<t>.tables[].chart"),
    "",
  ].join("\n");
}
