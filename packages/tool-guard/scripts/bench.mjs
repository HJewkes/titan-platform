#!/usr/bin/env node
// Whole-process latency of `titan-tool-guard hook` (risk R6: p95 under 150 ms on the owner's machine).
// Not run in CI. Build first, then: node scripts/bench.mjs [--runs 100]
// Every run uses a temp HOME and log, so nothing touches the real home directory.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 100;

const EVENTS = {
  "read, unguarded": (home) => ({ tool_name: "Read", cwd: home, tool_input: { file_path: `${home}/notes.txt` } }),
  "read, guarded": (home) => ({ tool_name: "Read", cwd: home, tool_input: { file_path: `${home}/.npmrc` } }),
  "bash, merge": (home) => ({ tool_name: "Bash", cwd: home, tool_input: { command: "gh pr merge 1 --squash" } }),
};

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function bench(name, event, home) {
  const env = { PATH: process.env.PATH, HOME: home, TITAN_TOOL_GUARD_LOG: path.join(home, "guard.log") };
  const input = JSON.stringify(event(home));
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const start = process.hrtime.bigint();
    spawnSync(process.execPath, [BIN, "hook"], { input, env });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${name}: p50 ${percentile(times, 50).toFixed(1)} ms, p95 ${percentile(times, 95).toFixed(1)} ms (${RUNS} runs)`);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tool-guard-bench-"));
try {
  for (const [name, event] of Object.entries(EVENTS)) bench(name, event, home);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
