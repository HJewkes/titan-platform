#!/usr/bin/env node
// CI's sharded test run (TP-4436): plan the files test-scope.mjs puts in scope into duration-balanced shards, run one
// shard, judge every shard for validate (the one required test context), and fold the shards' durations back into the
// results cache main saves for the next plan.
// Usage: node scripts/test-plan.mjs plan <plan.json>         (reads EVENT_NAME, HEAD_REF, BASE_SHA and HEAD_SHA)
//        node scripts/test-plan.mjs run <plan.json> <index> <results-out.json>
//        node scripts/test-plan.mjs judge <jobs.json>        (reads TEST_SHARDS; exit 0 green, 1 red, 75 still running)
//        node scripts/test-plan.mjs merge <plan.json> <shard-results-dir>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, describeScope, PROJECTS, readWorkspace, scopeForEvent, vitestArgs } from "./test-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const RESULTS_GLOB = "node_modules/.vite/vitest/*/results.json";

// Each shard is one runner, so the caps bound one run's share of the account's concurrent jobs.
export const SHARD_CAPS = { main: 6, pullRequest: 4 };
const TARGET_SHARD_SECONDS = 300;
// vitest.config.ts maxWorkers.
const WORKERS = 4;
// results.json records test time only. Transform, setup, import and environment took 2,018 worker-s over 2,473 files
// on main's full run, so each file carries that share on top.
const PER_FILE_OVERHEAD_SECONDS = 0.8;
export const PENDING_EXIT = 75;

const resultKey = (file) => `${file.project}:${file.path}`;

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Each file's cost in worker-seconds: its last duration on main, or the median duration for a file main never ran. */
export function fileCosts(files, durationsMs) {
  const fallbackMs = median([...durationsMs.values()]);
  return files.map((file) => {
    const known = durationsMs.has(resultKey(file));
    const ms = known ? durationsMs.get(resultKey(file)) : fallbackMs;
    return { ...file, known, seconds: ms / 1000 + PER_FILE_OVERHEAD_SECONDS };
  });
}

/** With no durations at all (a cold cache) the estimate is only overhead, so the full cap runs rather than too few. */
export function shardCount(costs, cap) {
  if (costs.length === 0) return 0;
  if (!costs.some((file) => file.known)) return Math.min(cap, costs.length);
  const wallSeconds = costs.reduce((sum, file) => sum + file.seconds, 0) / WORKERS;
  return Math.min(cap, costs.length, Math.max(1, Math.ceil(wallSeconds / TARGET_SHARD_SECONDS)));
}

/** Longest file first into the lightest bin. A bin's wall estimate is its share of the workers, or its longest file. */
export function packBins(costs, count) {
  const bins = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  const longestFirst = [...costs].sort((a, b) => b.seconds - a.seconds || a.path.localeCompare(b.path));
  for (const file of longestFirst) {
    const lightest = bins.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best));
    lightest.files.push(file);
    lightest.seconds += file.seconds;
  }
  return bins.map((bin) => ({ files: bin.files, estimateSeconds: Math.max(bin.seconds / WORKERS, bin.files[0]?.seconds ?? 0) }));
}

export function planShards(files, durationsMs, cap) {
  const costs = fileCosts(files, durationsMs);
  const bins = packBins(costs, shardCount(costs, cap));
  return bins.map((bin, i) => ({
    index: i + 1,
    total: bins.length,
    estimateSeconds: Math.round(bin.estimateSeconds),
    files: bin.files.map(({ path, project }) => ({ path, project })),
  }));
}

/** The matrix and judge only need each shard's identity and size; the file lists travel in the plan artifact. */
export const shardSummaries = (shards) => shards.map(({ files, ...shard }) => ({ ...shard, fileCount: files.length }));

export const shardJobName = (shard) => `test (${shard.index}/${shard.total})`;

const elapsedSeconds = (job) => Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000);

/** Green only once every planned shard's job completed with success; a shard not yet listed is still pending. */
export function judgeShards(shards, jobs) {
  const rows = shards.map((shard) => ({ shard, job: jobs.find((job) => job.name === shardJobName(shard)) }));
  if (rows.some(({ job }) => job?.status !== "completed")) return { state: "pending", rows };
  const red = rows.some(({ job }) => job.conclusion !== "success");
  return { state: red ? "red" : "green", rows };
}

export function judgeTable(rows) {
  const lines = rows.map(({ shard, job }) => {
    return `| ${shardJobName(shard)} | ${shard.fileCount} | ${shard.estimateSeconds} | ${elapsedSeconds(job)} | ${job.conclusion} |`;
  });
  return ["| shard | files | estimate (s) | actual job (s) | conclusion |", "|---|---|---|---|---|", ...lines].join("\n");
}

/** Main's previous durations for files still in the plan, overlaid with what the shards just measured. */
export function mergeResults(previous, measured, planned) {
  const keep = new Set(planned.map(resultKey));
  const merged = new Map(previous.filter(([key]) => keep.has(key)));
  for (const [key, value] of measured) if (keep.has(key)) merged.set(key, value);
  return [...merged.entries()];
}

function readResultsCache() {
  const caches = globSync(RESULTS_GLOB, { cwd: ROOT }).map((path) => ({ path, ...JSON.parse(readFileSync(join(ROOT, path), "utf8")) }));
  return { path: caches[0]?.path, version: caches[0]?.version, results: caches.flatMap((cache) => cache.results ?? []) };
}

function listFiles(scope, out) {
  const filters = scope.mode === "scoped" ? scope.dirs : [];
  const args = ["list", "--filesOnly", "--passWithNoTests", `--json=${out}`, ...PROJECTS.flatMap((p) => ["--project", p]), ...filters];
  const result = spawnSync(process.execPath, [VITEST, ...args], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`vitest list exited ${result.status}`);
  return JSON.parse(readFileSync(out, "utf8")).map((entry) => ({ path: relative(ROOT, entry.file), project: entry.projectName }));
}

function summarize(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function planCommand(planPath) {
  const scope = scopeForEvent(process.env, changedFiles, readWorkspace);
  const files = scope.mode === "none" ? [] : listFiles(scope, `${planPath}.files.json`);
  const durations = new Map(readResultsCache().results.map(([key, value]) => [key, value.duration]));
  const cap = process.env.EVENT_NAME === "pull_request" ? SHARD_CAPS.pullRequest : SHARD_CAPS.main;
  const shards = planShards(files, durations, cap);
  writeFileSync(planPath, JSON.stringify({ shards }));
  const unknown = files.filter((file) => !durations.has(resultKey(file))).length;
  summarize(`${describeScope(scope)}\n\n${files.length} files (${unknown} with no duration on main) in ${shards.length} shards\n`);
  summarize(shards.map((shard) => `- ${shardJobName(shard)}: ${shard.files.length} files, estimate ${shard.estimateSeconds} s`).join("\n"));
  output("count", shards.length);
  output("shards", JSON.stringify(shardSummaries(shards)));
}

function writeShardResults(shard, out) {
  const measured = mergeResults([], readResultsCache().results, shard.files);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out,JSON.stringify({ results: measured }));
}

function runCommand(planPath, index, resultsOut) {
  const shard = JSON.parse(readFileSync(planPath, "utf8")).shards.find((entry) => entry.index === Number(index));
  if (!shard) throw new Error(`the plan has no shard ${index}`);
  const started = Date.now();
  const args = vitestArgs({ mode: "scoped", dirs: shard.files.map((file) => file.path) }, process.env);
  const result = spawnSync(process.execPath, [VITEST, ...args], { cwd: ROOT, stdio: "inherit" });
  const actual = Math.round((Date.now() - started) / 1000);
  const list = shard.files.map((file) => `- ${file.path}`).join("\n");
  summarize(`${shardJobName(shard)}: ${shard.files.length} files, estimate ${shard.estimateSeconds} s, actual ${actual} s\n`);
  summarize(`<details><summary>files</summary>\n\n${list}\n\n</details>`);
  writeShardResults(shard, resultsOut);
  process.exitCode = result.status ?? 1;
}

function judgeCommand(jobsPath) {
  const shards = JSON.parse(process.env.TEST_SHARDS || "[]");
  const { state, rows } = judgeShards(shards, JSON.parse(readFileSync(jobsPath, "utf8")).jobs);
  if (state === "pending") return PENDING_EXIT;
  if (rows.length > 0) summarize(judgeTable(rows));
  if (state === "red") console.error("error: a test shard did not succeed");
  return state === "red" ? 1 : 0;
}

function mergeCommand(planPath, shardResultsDir) {
  const planned = JSON.parse(readFileSync(planPath, "utf8")).shards.flatMap((shard) => shard.files);
  const measured = globSync("*.json", { cwd: shardResultsDir }).flatMap((name) => JSON.parse(readFileSync(join(shardResultsDir, name), "utf8")).results);
  const previous = readResultsCache();
  // vitest keeps the root's results under the sha1 of its empty project label.
  const path = previous.path ?? join("node_modules/.vite/vitest", createHash("sha1").update("").digest("hex"), "results.json");
  const version = previous.version ?? JSON.parse(readFileSync(join(ROOT, "node_modules/vitest/package.json"), "utf8")).version;
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), JSON.stringify({ version, results: mergeResults(previous.results, measured, planned) }));
}

const COMMANDS = { plan: planCommand, run: runCommand, judge: judgeCommand, merge: mergeCommand };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!COMMANDS[command]) throw new Error(`unknown command ${command}; expected ${Object.keys(COMMANDS).join(", ")}`);
    const code = COMMANDS[command](...args);
    if (typeof code === "number") process.exitCode = code;
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
