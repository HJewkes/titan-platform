import type { BaseRate, ServedReport, Tally } from "./report.js";

/** Plain-text tables in the §1.2 shape: served, opened, rate, then the unserved control. */

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "-" : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function baseCell(baseRate?: BaseRate): string {
  return baseRate ? `${pct(baseRate.opened, baseRate.unserved)} (${baseRate.opened} of ${baseRate.unserved})` : "-";
}

function tallyCells(tally: Tally): string[] {
  return [String(tally.served), String(tally.opened), pct(tally.opened, tally.served), String(tally.cited)];
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

function spanLine(report: ServedReport): string {
  const spans = Object.entries(report.blockSpan).map(([trigger, span]) => `${trigger} ${span.first} to ${span.last}`);
  return `blocks rendered: ${spans.length > 0 ? spans.join("; ") : "none"}`;
}

const TALLY_HEADER = ["served", "opened", "rate", "cited"];

export function formatServed(report: ServedReport, fileLimit = 20): string {
  const { window, transcriptsServed: served } = report;
  const sections = [
    `window: ${window.since ?? "(open)"} to ${window.until ?? "(open)"}; transcripts scanned ${report.transcriptsScanned}; ` +
      `with a block: bootstrap ${served.bootstrap}, spawn ${served.spawn}`,
    spanLine(report),
    `opened-section: ${report.openedSection}`,
    table(
      ["trigger", "class", ...TALLY_HEADER, "unserved base rate"],
      report.byClass.map((row) => [row.trigger, row.refClass, ...tallyCells(row), baseCell(row.baseRate)]),
    ),
    table(
      ["trigger", "initiative", "class", ...TALLY_HEADER, "unserved base rate"],
      report.byInitiative.map((row) => [
        row.trigger,
        row.initiative,
        row.refClass,
        ...tallyCells(row),
        baseCell(row.baseRate),
      ]),
    ),
    table(
      ["trigger", "foreign", "class", ...TALLY_HEADER],
      report.byForeign.map((row) => [row.trigger, String(row.foreign), row.refClass, ...tallyCells(row)]),
    ),
    table(
      ["trigger", "ref", ...TALLY_HEADER],
      report.byFile.slice(0, fileLimit).map((row) => [row.trigger, row.ref, ...tallyCells(row)]),
    ),
  ];
  return sections.join("\n\n");
}
