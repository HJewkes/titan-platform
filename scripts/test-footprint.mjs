#!/usr/bin/env node
// What each test file costs the machine (TP-4571): CPU with children, processes spawned, temp files created and left,
// peak fds and memory. Linux only; it reads /proc.
//
//   node scripts/test-footprint.mjs run --out <dir> [-- <vitest args>]   one instrumented run, then its report
//   node scripts/test-footprint.mjs report <dir>                         redo the report from a run's records
//
// A run writes <dir>/footprint.md (totals and rankings), files.tsv (every file) and the raw records. It keeps the
// project's pool settings. Reading the numbers:
// - CPU marked ~ belongs to a thread-pool file: threads share a process, so their children's CPU is known only in total
//   and is split by each file's child wall time. A fork file's is exact. Self CPU is exact in both, but a thread file's
//   leaves out GC and compiler helper threads, which count as outside any file.
// - Spawns are the worker's direct children; what a shell or git starts in turn is in the CPU, not the count.
// - Peak fds in a thread file include the other files sharing its process. Peak memory is VmHWM for a fork and V8 heap
//   plus external for a thread, whose RSS is the shared process's; children's memory is not included.
// - Each file gets its own TMPDIR, so a module that caches tmpdir() across a shared fork leaves later files' paths in the
//   first file's dir, and a test asserting that cached path against tmpdir() fails here and nowhere else.
// - A /tmp entry is split over the files running when it appeared, and other users of the machine count too.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FOOTPRINT_DIR_VAR, buildReport, parseDfInodes, parseProcStat, renderMarkdown, renderTsv } from "./test-footprint-core.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHER = join(import.meta.dirname, "test-footprint-watch.mjs");
const VITEST = join(REPO_ROOT, "node_modules/vitest/vitest.mjs");
const SHARED_TMP = "/tmp";
const POLL_MS = 1000;

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

function readRows(dir) {
  if (!existsSync(dir)) return [];
  const lines = readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"));
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

function readTiming(dir) {
  if (!existsSync(dir)) return null;
  const [name] = readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  return name ? readJson(join(dir, name)) : null;
}

export function writeReport(out) {
  const report = buildReport({ rows: readRows(join(out, "rows")), watch: readJson(join(out, "watch.json")), timing: readTiming(join(out, "timing")), run: readJson(join(out, "run.json")), root: REPO_ROOT });
  writeFileSync(join(out, "footprint.md"), renderMarkdown(report));
  writeFileSync(join(out, "files.tsv"), renderTsv(report));
  return report;
}

function tmpSnapshot() {
  return { names: readdirSync(SHARED_TMP), df: parseDfInodes(execFileSync("df", ["-i", SHARED_TMP], { encoding: "utf8" })) };
}

function treeCounts(path) {
  try {
    const entries = readdirSync(path, { withFileTypes: true, recursive: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).length;
    return { files: entries.length - dirs, dirs };
  } catch {
    return { files: 0, dirs: 0 };
  }
}

function leftInSharedTmp(before, after) {
  const earlier = new Set(before.names);
  return after.names.filter((name) => !earlier.has(name)).flatMap((name) => {
    const path = join(SHARED_TMP, name);
    try {
      const stat = lstatSync(path);
      if (stat.uid !== process.getuid()) return [];
      return [{ name, atMs: stat.birthtimeMs, ...treeCounts(path) }];
    } catch {
      return [];
    }
  });
}

function readProcess(pid) {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

const processMs = (stat) => stat.userMs + stat.sysMs;
const childrenMs = (stat) => stat.childUserMs + stat.childSysMs;

function runVitest(args, out, onExit) {
  const env = { ...process.env, [FOOTPRINT_DIR_VAR]: join(out, "rows"), TITAN_TEST_TIMING_SPOOL: join(out, "timing"), TITAN_TEST_TIMING_SCOPE: "footprint" };
  const child = spawn(process.execPath, [VITEST, "run", ...args], { cwd: REPO_ROOT, env, stdio: "inherit" });
  const peak = { load1: 0, stat: null };
  const poll = setInterval(() => {
    peak.stat = readProcess(child.pid) ?? peak.stat;
    peak.load1 = Math.max(peak.load1, loadavg()[0]);
  }, POLL_MS);
  child.once("close", (code, signal) => {
    clearInterval(poll);
    onExit({ code: code ?? 1, signal, peak });
  });
  return child;
}

function stopWatcher(watcher) {
  return new Promise((done) => {
    watcher.once("close", done);
    watcher.kill("SIGTERM");
  });
}

function runHeader({ before, after, startedAt, result, watcherStat }) {
  const self = parseProcStat(readFileSync("/proc/self/stat", "utf8"));
  const { stat } = result.peak;
  return {
    startedAt, wallMs: Date.now() - startedAt, exit: result.code, signal: result.signal, peakLoad1: result.peak.load1,
    wholeRunMs: childrenMs(self) - (watcherStat ? processMs(watcherStat) : 0),
    main: stat ? { selfMs: processMs(stat), childMs: childrenMs(stat) } : null,
    watcherMs: watcherStat ? processMs(watcherStat) : null,
    tmpEntries: { before: before.names.length, after: after.names.length }, tmpInodes: { before: before.df, after: after.df },
    tmpLeft: leftInSharedTmp(before, after),
  };
}

async function run(args) {
  const separator = args.indexOf("--");
  const vitestArgs = separator === -1 ? [] : args.slice(separator + 1);
  const outFlag = args.indexOf("--out");
  if (outFlag === -1) throw new Error("run needs --out <dir>");
  const out = resolve(args[outFlag + 1]);
  mkdirSync(join(out, "rows"), { recursive: true });
  const before = tmpSnapshot();
  const startedAt = Date.now();
  const watcher = spawn(process.execPath, [WATCHER, join(out, "watch.json"), tmpdir(), SHARED_TMP], { stdio: "inherit" });
  const result = await new Promise((done) => {
    const vitest = runVitest(vitestArgs, out, done);
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => vitest.kill(signal));
  });
  const watcherStat = readProcess(watcher.pid);
  await stopWatcher(watcher);
  writeFileSync(join(out, "run.json"), `${JSON.stringify(runHeader({ before, after: tmpSnapshot(), startedAt, result, watcherStat }), null, 2)}\n`);
  const { totals } = writeReport(out);
  process.stdout.write(`footprint: ${totals.files} files, report in ${join(out, "footprint.md")}\n`);
  return result.code;
}

async function main([command, ...args]) {
  if (command === "run") return run(args);
  if (command === "report" && args[0]) {
    writeReport(resolve(args[0]));
    return 0;
  }
  process.stderr.write("usage: test-footprint.mjs run --out <dir> [-- <vitest args>] | report <dir>\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
