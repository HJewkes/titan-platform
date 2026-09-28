import { RULE_IDS } from "./rules.js";
import { zeroCounts, type Finding, type RuleCounts } from "./scan.js";

export interface ReportSummary {
  readonly allowed: RuleCounts;
  readonly binaryFilesSkipped: number;
  readonly termsLoaded: boolean;
}

function formatFinding(finding: Finding): string {
  const term = finding.termIndex === undefined ? "" : ` #${finding.termIndex}`;
  return `${finding.location} ${finding.rule}${term}`;
}

function formatCounts(counts: RuleCounts, rules: readonly string[]): string {
  return rules.map((rule) => `${rule} ${counts[rule as keyof RuleCounts]}`).join(", ");
}

/**
 * Formats findings as `<location> <rule>[ #<termIndex>]` lines plus a summary. It takes no
 * scanned text, so it cannot echo a matched line, path fragment or term.
 */
export function formatReport(findings: readonly Finding[], summary: ReportSummary): string[] {
  const found = zeroCounts();
  for (const finding of findings) found[finding.rule]++;
  const plural = findings.length === 1 ? "finding" : "findings";
  return [
    ...findings.map(formatFinding),
    `egress-scan: ${findings.length} ${plural} (${formatCounts(found, RULE_IDS)})`,
    `allowed: ${formatCounts(summary.allowed, ["home-path", "aw-data-path"])}`,
    `binary files skipped: ${summary.binaryFilesSkipped}`,
    `private term list: ${summary.termsLoaded ? "loaded" : "not loaded, generic rules only"}`,
  ];
}
