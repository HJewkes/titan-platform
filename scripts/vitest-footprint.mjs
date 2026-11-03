// vitest setup file for scripts/test-footprint.mjs (TP-4571): one row per test file of what it cost the machine. It
// reads /proc from the worker itself because a worker runs one file at a time: a /proc/thread-self read is that file's
// CPU, a spawn hook sees that file's children, and a per-file TMPDIR holds that file's leftovers. A run without
// TITAN_TEST_FOOTPRINT_DIR never loads this. Builtins come from process.getBuiltinModule so a test's vi.mock of node:fs
// cannot reach them, and the clocks are captured at load so fake timers cannot.
import { afterAll, expect } from "vitest";
import { FOOTPRINT_DIR_VAR, commandOf, parseProcStat, parseVmHwm } from "./test-footprint-core.mjs";

const SAMPLE_MS = 200;
const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"];
const STATE = Symbol.for("titan.test-footprint");
const fs = process.getBuiltinModule("node:fs");
const os = process.getBuiltinModule("node:os");
const path = process.getBuiltinModule("node:path");
const { isMainThread, threadId } = process.getBuiltinModule("node:worker_threads");
const { ChildProcess } = process.getBuiltinModule("node:child_process");

const nsToMs = (ns) => Number(ns) / 1e6;
const procStat = (target) => parseProcStat(fs.readFileSync(target, "utf8"));
const selfStat = () => procStat(isMainThread ? "/proc/self/stat" : "/proc/thread-self/stat");
const openFds = () => fs.readdirSync("/proc/self/fd").length;

function recordSpawn(file, name, wallNs) {
  if (!file) return;
  file.spawns += 1;
  file.commands[name] = (file.commands[name] ?? 0) + 1;
  file.childWallNs += wallNs;
}

// spawn, exec, execFile and fork all end in ChildProcess.prototype.spawn. execSync and execFileSync call an internal
// spawnSync, so the one place that sees all three sync calls is the binding under them.
function hookSpawns(state) {
  const spawnChild = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function footprintSpawn(options) {
    const result = spawnChild.call(this, options);
    const file = state.current;
    if (this.pid === undefined || !file) return result;
    const startNs = state.clock();
    file.live.set(this, startNs);
    this.once("exit", () => {
      if (file.live.delete(this)) file.exitedChildNs.push(state.clock() - startNs);
    });
    recordSpawn(file, commandOf(options.file, options.args), 0n);
    return result;
  };
  const binding = process.binding("spawn_sync");
  const spawnSync = binding.spawn;
  binding.spawn = function footprintSpawnSync(options) {
    const startNs = state.clock();
    try {
      return spawnSync.call(this, options);
    } finally {
      recordSpawn(state.current, commandOf(options.file, options.args), state.clock() - startNs);
    }
  };
}

function isolateMemoryKb() {
  const { heapTotal, external } = process.memoryUsage();
  return Math.round((heapTotal + external) / 1024);
}

function sample(file) {
  file.peakFds = Math.max(file.peakFds, openFds());
  file.peakIsolateKb = Math.max(file.peakIsolateKb, isolateMemoryKb());
  file.peakRssKb = Math.max(file.peakRssKb, Math.round(process.memoryUsage.rss() / 1024));
}

function countTree(root) {
  const counts = { files: 0, dirs: 0 };
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      counts[entry.isDirectory() ? "dirs" : "files"] += 1;
    }
  }
  return counts;
}

function install() {
  const dir = process.env[FOOTPRINT_DIR_VAR];
  if (!dir) return null;
  // A test that spawns vitest must not append its nested run to this one.
  delete process.env[FOOTPRINT_DIR_VAR];
  const state = { dir, current: null, clock: process.hrtime.bigint, now: Date.now };
  hookSpawns(state);
  setInterval(() => state.current && sample(state.current), SAMPLE_MS).unref();
  return state;
}

function restoreTemp(file) {
  for (const name of TEMP_VARS) {
    if (file.savedTemp[name] === undefined) delete process.env[name];
    else process.env[name] = file.savedTemp[name];
  }
}

function begin(state) {
  // A file that failed to import never ran its afterAll; in a shared fork the next file starts on top of it.
  if (state.current) restoreTemp(state.current);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f-"));
  const savedTemp = Object.fromEntries(TEMP_VARS.map((name) => [name, process.env[name]]));
  for (const name of TEMP_VARS) process.env[name] = tmpDir;
  if (isMainThread) fs.writeFileSync("/proc/self/clear_refs", "5");
  const memoryStartKb = isMainThread ? Math.round(process.memoryUsage.rss() / 1024) : isolateMemoryKb();
  const file = {
    tmpDir, savedTemp, memoryStartKb, startFds: openFds(), startMs: state.now(), startNs: state.clock(), startStat: selfStat(),
    spawns: 0, commands: {}, childWallNs: 0n, live: new Map(), exitedChildNs: [], peakFds: 0, peakIsolateKb: 0, peakRssKb: 0,
  };
  sample(file);
  state.current = file;
}

const childWallMs = (state, file) => {
  const stillRunning = [...file.live.values()].map((startNs) => state.clock() - startNs);
  return nsToMs([...file.exitedChildNs, ...stillRunning].reduce((total, ns) => total + ns, file.childWallNs));
};

function memoryPeakKb(file) {
  if (!isMainThread) return file.peakIsolateKb;
  return parseVmHwm(fs.readFileSync("/proc/self/status", "utf8")) ?? file.peakRssKb;
}

function finish(state, testPath) {
  const { current: file } = state;
  state.current = null;
  sample(file);
  const end = selfStat();
  const { startStat } = file;
  const row = {
    file: testPath, pid: process.pid, threadId, pool: isMainThread ? "fork" : "thread", startMs: file.startMs, endMs: state.now(),
    wallMs: nsToMs(state.clock() - file.startNs), userMs: end.userMs - startStat.userMs, sysMs: end.sysMs - startStat.sysMs,
    childUserMs: end.childUserMs - startStat.childUserMs, childSysMs: end.childSysMs - startStat.childSysMs,
    processTotalMs: end.userMs + end.sysMs + end.childUserMs + end.childSysMs,
    spawns: file.spawns, commands: file.commands, childWallMs: childWallMs(state, file),
    peakFds: file.peakFds, startFds: file.startFds, peakRssKb: file.peakRssKb, memoryPeakKb: memoryPeakKb(file), memoryStartKb: file.memoryStartKb,
    tmpDir: path.basename(file.tmpDir), left: countTree(file.tmpDir),
  };
  restoreTemp(file);
  fs.appendFileSync(path.join(state.dir, `rows-${process.pid}.jsonl`), `${JSON.stringify(row)}\n`);
}

// vitest re-evaluates this file per test file in a shared fork, so the hooks and the sampler live on globalThis.
globalThis[STATE] ??= install();
const state = globalThis[STATE];

if (state) {
  begin(state);
  afterAll(() => finish(state, expect.getState().testPath));
}
