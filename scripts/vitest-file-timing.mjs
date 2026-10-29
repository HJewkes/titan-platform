import { appendFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

// The default reporter prints only each file's test time, so which imports are heavy stayed a guess (TP-4436 S0).
// This reporter writes every file's collect (import), setup and test time to a JSON artifact and the slowest files by
// each to the step summary.
export const TIMING_FILE = "vitest-file-timing.json";
export const TOP = 30;
const PHASES = [
  ["collect", "collectMs"],
  ["setup", "setupMs"],
  ["test", "testMs"],
];

export function timingRow(testModule) {
  const diagnostic = testModule.diagnostic();
  return {
    project: testModule.project.name,
    file: relative(process.cwd(), testModule.moduleId),
    state: testModule.state(),
    environmentMs: Math.round(diagnostic.environmentSetupDuration),
    prepareMs: Math.round(diagnostic.prepareDuration),
    collectMs: Math.round(diagnostic.collectDuration),
    setupMs: Math.round(diagnostic.setupDuration),
    testMs: Math.round(diagnostic.duration),
  };
}

export function slowestBy(rows, key, count = TOP) {
  return [...rows].sort((a, b) => b[key] - a[key]).slice(0, count);
}

const seconds = (ms) => (ms / 1000).toFixed(1);

function phaseTable(rows, label, key, count) {
  const total = rows.reduce((sum, row) => sum + row[key], 0);
  const lines = slowestBy(rows, key, count).map((row) => `| ${seconds(row[key])} | ${row.project} | ${row.file} |`);
  return [`#### Slowest ${count} files by ${label} (${seconds(total)} s over ${rows.length} files)`, "", `| ${label} s | project | file |`, "|---|---|---|", ...lines, ""].join("\n");
}

export function summaryMarkdown(rows, count = TOP) {
  return ["### Vitest file timing", "", ...PHASES.map(([label, key]) => phaseTable(rows, label, key, count))].join("\n");
}

export default class FileTiming {
  rows = [];

  constructor({ out = process.env.VITEST_FILE_TIMING ?? TIMING_FILE, summary = process.env.GITHUB_STEP_SUMMARY, write = writeFileSync, append = appendFileSync } = {}) {
    Object.assign(this, { out, summary, write, append });
  }

  onTestModuleEnd(testModule) {
    this.rows.push(timingRow(testModule));
  }

  onTestRunEnd() {
    this.write(this.out, `${JSON.stringify({ files: this.rows }, null, 2)}\n`);
    if (this.summary) this.append(this.summary, summaryMarkdown(this.rows));
  }
}
