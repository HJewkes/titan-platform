import type { Rules } from "./rules.js";
import type { Finding, ScanResult } from "./scan.js";

export const RULES_PATH = ".github/merge-lint.json";

export interface Report {
  lines: string[];
  /** Hits no allow entry covers. */
  unallowed: number;
}

function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotation(file: string | null, line: number | null, message: string): string {
  const where = file === null ? "" : `file=${escapeProperty(file)},${line === null ? "" : `line=${line},`}`;
  return `::warning ${where}title=merge-lint::${escapeData(message)}`;
}

function plain(file: string | null, line: number | null, message: string): string {
  const where = file === null ? "" : `${file}${line === null ? "" : `:${line}`}: `;
  return `merge-lint: warn ${where}${message}`;
}

/** One line per finding: `path:line` first, so a CI log links to the file. */
export function formatFinding(finding: Finding, actions: boolean): string {
  const message = `${finding.shape}: a merge call outside the allowlist in ${RULES_PATH}: ${finding.text.slice(0, 120)}`;
  return actions ? annotation(finding.path, finding.line, message) : plain(finding.path, finding.line, message);
}

function noteLines(result: ScanResult, rules: Rules, actions: boolean): string[] {
  const emit = actions ? (m: string) => annotation(RULES_PATH, null, m) : (m: string) => plain(RULES_PATH, null, m);
  const stale = result.stale.map((i) => emit(`stale allow entry matches no merge call: ${rules.allow[i]?.path}`));
  const notLogging = result.notLogging.flatMap((i) => {
    const entry = rules.allow[i];
    return entry?.kind === "wrapper" ? [emit(`wrapper ${entry.mergePath} (${entry.path}) does not log yet (logs: false)`)] : [];
  });
  return [...stale, ...notLogging];
}

export function buildReport(result: ScanResult, rules: Rules, actions: boolean): Report {
  const unallowed = result.findings.filter((f) => f.allowedBy === null);
  const lines = [...unallowed.map((f) => formatFinding(f, actions)), ...noteLines(result, rules, actions)];
  return { lines, unallowed: unallowed.length };
}

export function summaryLine(result: ScanResult, report: Report, level: Rules["level"]): string {
  return `merge-lint: level ${level}: ${report.unallowed} unallowed, ${result.findings.length - report.unallowed} allowed, ${result.stale.length} stale, ${result.notLogging.length} not logging`;
}

/** A tracked file the lint could not read was not scanned; saying so keeps a clean run from reading as full coverage. */
export function unreadableLine(path: string, actions: boolean): string {
  const message = "tracked file could not be read, so it was not scanned";
  return actions ? annotation(path, null, message) : plain(path, null, message);
}
