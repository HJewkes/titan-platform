import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, relative } from "node:path";
import { TIMING_SCHEMA, readGit, recordPath, runHeader, sampleLoad } from "./test-timing-record.mjs";

// The default reporter prints only each file's test time, so which imports are heavy stayed a guess (TP-4436 S0).
// This reporter writes every file's collect (import), setup and test time to a JSON artifact and the slowest files by
// each to the step summary. Each run is one titan.test-timing/v1 record: a run header and a row per file (TP-4465 S1).
export const TOP = 30;
const PHASES = [
  ["collect", "collectMs"],
  ["setup", "setupMs"],
  ["test", "testMs"],
];

export function timingRow(testModule) {
  const diagnostic = testModule.diagnostic();
  const [collectMs, setupMs, testMs] = [diagnostic.collectDuration, diagnostic.setupDuration, diagnostic.duration].map(Math.round);
  return {
    project: testModule.project.name,
    file: relative(process.cwd(), testModule.moduleId),
    state: testModule.state(),
    environmentMs: Math.round(diagnostic.environmentSetupDuration),
    prepareMs: Math.round(diagnostic.prepareDuration),
    collectMs,
    setupMs,
    testMs,
    totalMs: collectMs + setupMs + testMs,
    tests: [...testModule.children.allTests()].length,
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

function scopeOf(env, vitest) {
  if (env.TITAN_TEST_TIMING_SCOPE) return { mode: env.TITAN_TEST_TIMING_SCOPE, filters: [] };
  if (vitest?.config.related) return { mode: "related", filters: vitest.config.related };
  // filenamePattern is internal to vitest 4: the CLI file filters, which test-scope passes only for a scoped run.
  const filters = vitest?.filenamePattern ?? [];
  return { mode: filters.length > 0 ? "scoped" : "full", filters };
}

function writeRecord(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

const shardOf = (vitest) => (vitest?.config.shard ? `${vitest.config.shard.index}/${vitest.config.shard.count}` : null);

export default class FileTiming {
  rows = [];

  constructor({ env = process.env, git = readGit, clock = globalThis, load = () => loadavg()[0], now = Date.now, write = writeRecord, append = appendFileSync } = {}) {
    Object.assign(this, { env, git, clock, load, now, write, append });
  }

  onInit(vitest) {
    this.vitest = vitest;
  }

  onTestRunStart() {
    this.startMs = this.now();
    this.stopLoad = sampleLoad({ loadavg: this.load, setInterval: this.clock.setInterval, clearInterval: this.clock.clearInterval });
  }

  onTestModuleEnd(testModule) {
    this.rows.push(timingRow(testModule));
  }

  onTestRunEnd(_testModules, _errors, reason) {
    const record = { schema: TIMING_SCHEMA, run: this.header(reason), files: this.rows };
    const out = recordPath(this.env, record.run.id);
    if (out) this.write(out, `${JSON.stringify(record, null, 2)}\n`);
    if (this.env.GITHUB_STEP_SUMMARY) this.append(this.env.GITHUB_STEP_SUMMARY, summaryMarkdown(this.rows));
  }

  header(reason) {
    const startMs = this.startMs ?? this.now();
    const load = this.stopLoad?.() ?? null;
    const { env, git, vitest } = this;
    const startedAt = new Date(startMs).toISOString();
    const base = runHeader({ env, git, startedAt, scope: scopeOf(env, vitest), shard: shardOf(vitest), maxWorkers: vitest?.config.maxWorkers ?? null, vitest: vitest?.version ?? null });
    return { ...base, load, wallMs: this.now() - startMs, exit: reason ?? null };
  }
}
