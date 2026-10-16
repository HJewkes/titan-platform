#!/usr/bin/env node
// scripts/dag-check.sh on the ported code-graph engine; BASE_REF marks existing violations carryover, --json prints the result, exit 0/1/2 as codewatch.
// --report <file> also writes codewatch-pr-report@1 (scripts/codewatch-report.mjs); a failed write never changes the exit code.
// The lock holder indexes in a child process, so a signal or an OOM in the indexer still releases the lock and cleans up at once;
// an OOM exits 2 and says so, except a seeded run, which retries once cold. --db <path> keeps the finished graph there for `dead:check --db`, which would otherwise re-index.
// --seed-db <path> starts from a graph a CI cache restored: the indexer re-parses only changed files and drops deleted ones (TP-1854).
// Without one, a local run seeds from the machine-wide graph the last finished run left (DAG_CHECK_NO_SEED=1 opts out).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReport, writeReport } from "./codewatch-report.mjs";
import { MACHINE_SEED, refreshSeed, runWithColdRetry, seedArgs, usesMachineSeed } from "./dag-check-seed.mjs";
import { BUSY_EXIT_CODE, DEFAULT_LOCK_DIR, LockTimeoutError, acquire, lockSlots, lockWaitMs, cleanupOnSignal, release, runCappedWorker, runCleanups } from "./dag-check-lock.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const CONFIG = path.join(ROOT, ".codewatch/check.json");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");
// Live heap peaks near 460 MB cold and 930 MB seeded (the reuse basis sits beside the new index); uncapped,
// V8 lets garbage grow the process to about 4 GB. At 1024 MB every seeded run aborted and fell back to a 10-minute cold index.
const HEAP_CAP_MB = 2048;
const WORKER_FLAG = "--locked-worker";
const WORK_DIR_FLAG = "--work-dir";

/** Fixed per lock slot beside the lock, so the slot's next holder clears whatever a killed run left behind. */
export function workDirFor(slot) {
  const name = slot === 0 ? "dag-check-work" : `dag-check-work-${slot}`;
  return path.join(path.dirname(DEFAULT_LOCK_DIR), name);
}

function workPaths(dir) {
  return { dir, baseline: path.join(dir, "baseline"), db: path.join(dir, "graph.db") };
}

async function indexTree(graph, store, dir, ref) {
  // apps/ is absent from baselines taken before the first app landed.
  const paths = ["packages", "products", "apps"].map((sub) => path.join(dir, sub)).filter((p) => existsSync(p));
  const r = await graph.indexPaths(store, { paths, ref, computeChurn: false });
  console.error(`indexed ${ref}: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges -> snapshot ${r.snapshotId}`);
}

function git(...args) {
  execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

async function indexBaseline(graph, store, baseRef, baselineDir) {
  git("worktree", "prune");
  git("worktree", "add", "--detach", baselineDir, baseRef);
  try {
    await indexTree(graph, store, baselineDir, "baseline");
  } finally {
    git("worktree", "remove", "--force", baselineDir);
  }
}

function groupByRule(violations) {
  const grouped = new Map();
  for (const v of violations) grouped.set(v.ruleId, [...(grouped.get(v.ruleId) ?? []), v]);
  return grouped;
}

function violationLine(v) {
  const severity = v.severity === "error" ? "ERROR  " : "WARN   ";
  return `  ${v.isCarryover ? "CARRY " : ""}${severity}${v.nodeId}  ${v.message}`;
}

function statusLine(result, hasBaseline) {
  if (!hasBaseline) {
    return result.passed
      ? `${result.newWarnings} warning(s) — passed.`
      : `${result.newErrors} error(s), ${result.newWarnings} warning(s) — failed.`;
  }
  const carry = `${result.carryoverErrors + result.carryoverWarnings} carryover`;
  return result.passed
    ? `✓ no new violations (${result.newWarnings} new warning(s), ${carry}).`
    : `${result.newErrors} new error(s), ${result.newWarnings} new warning(s), ${carry} — failed.`;
}

function formatText({ snapshot, baselineSnapshot, result }) {
  const base = baselineSnapshot ? ` vs baseline snap ${baselineSnapshot.id} (${baselineSnapshot.ref})` : "";
  const lines = [`Graph check: snap ${snapshot.id} (${snapshot.ref})${base} — ${CONFIG}`, ""];
  if (result.violations.length === 0) {
    lines.push(`✓ ${result.rulesEvaluated} rule(s) passed across ${result.nodesEvaluated} node(s).`);
    return lines.join("\n");
  }
  for (const [ruleId, list] of groupByRule(result.violations)) {
    const carried = list.filter((v) => v.isCarryover).length;
    lines.push(baselineSnapshot ? `${ruleId} (${list.length - carried} new, ${carried} carryover)` : `${ruleId} (${list.length})`);
    lines.push(...list.map(violationLine), "");
  }
  lines.push(statusLine(result, !!baselineSnapshot));
  return lines.join("\n");
}

/**
 * A seeded snapshot may feed the reuse basis but never snapshot identity: with a commit it becomes the alias base
 * of the head index, so rename aliases (and the baseline's carry-over) would differ from a cold run's.
 */
export function forgetSeedCommits(store) {
  store.db.prepare("UPDATE snapshot SET commit_hash = NULL").run();
}

// A cache written by another schema or truncated mid-save must cost a cold index, never a failed check.
function openWorkStore(graph, workDb) {
  try {
    const store = graph.openCodeGraph(workDb);
    store.listSnapshots({ limit: 1 });
    if (seedDbPath(process.argv.slice(2))) forgetSeedCommits(store);
    return store;
  } catch (err) {
    console.error(`seed graph unusable, indexing cold: ${err instanceof Error ? err.message : String(err)}`);
    removeDb(workDb);
    return graph.openCodeGraph(workDb);
  }
}

function workerPaths(argv) {
  const at = argv.indexOf(WORK_DIR_FLAG);
  return workPaths(at >= 0 ? argv[at + 1] : workDirFor(0));
}

async function check() {
  const graph = await import(ENTRY);
  const baseRef = process.env.BASE_REF;
  const work = workerPaths(process.argv);
  const store = openWorkStore(graph, work.db);
  try {
    await indexTree(graph, store, ROOT, "head");
    if (baseRef) await indexBaseline(graph, store, baseRef, work.baseline);
    const rules = await graph.loadCheckRules(CONFIG, { onWarn: (m) => console.warn(`${CONFIG}: ${m}`) });
    const run = graph.checkSnapshot(store, { snapshot: "head", baseline: baseRef ? "baseline" : undefined, rules });
    const json = { ...run, baselineSnapshot: run.baselineSnapshot ?? null, configPath: CONFIG };
    console.log(process.argv.includes("--json") ? JSON.stringify(json, null, 2) : formatText(run));
    const reportAt = process.argv.indexOf("--report");
    if (reportAt >= 0) writeReport(process.argv[reportAt + 1], () => collectReport(graph, store, run, rules));
    // A cached graph keeps only what the next run can reuse: the head and baseline just indexed.
    if (seedDbPath(process.argv.slice(2))) graph.runPrune(store, { keep: 2 });
    return run.result.passed ? 0 : 1;
  } finally {
    store.close();
  }
}

function clearWorkDir(work) {
  if (existsSync(work.baseline)) {
    try {
      // The second --force removes a worktree that a killed `git worktree add` left locked.
      git("worktree", "remove", "--force", "--force", work.baseline);
    } catch {
      // A half-made or foreign baseline is not removable by git; deleting the directory and pruning is enough.
    }
  }
  rmSync(work.dir, { recursive: true, force: true, maxRetries: 5 });
  git("worktree", "prune");
}

export function keptDbPath(argv) {
  const at = argv.indexOf("--db");
  if (at < 0) return null;
  if (!argv[at + 1]) throw new Error("--db needs a path");
  return path.resolve(argv[at + 1]);
}

export function seedDbPath(argv) {
  const at = argv.indexOf("--seed-db");
  if (at < 0) return null;
  if (!argv[at + 1]) throw new Error("--seed-db needs a path");
  return path.resolve(argv[at + 1]);
}

function removeDb(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
}

/**
 * Copies a closed graph out of the work dir, which the next holder clears; a failed index keeps nothing, never a stale graph.
 * The copy lands by rename, so a reader holding another lock slot sees no graph or a whole one.
 */
export function keepDb({ workDb, dbPath, code }) {
  removeDb(dbPath);
  if (code !== 0 && code !== 1) return;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}`;
  try {
    copyFileSync(workDb, tmp);
    renameSync(tmp, dbPath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// A seed that cannot be written costs the next run a cold index, never this run's result.
function refreshMachineSeed(workDb, code) {
  try {
    if (refreshSeed({ workDb, seedPath: MACHINE_SEED, code })) console.error(`refreshed the machine seed ${MACHINE_SEED}`);
  } catch (err) {
    console.error(`machine seed not refreshed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resetWorkDir(work) {
  clearWorkDir(work);
  mkdirSync(work.dir, { recursive: true });
}

async function indexUnderLock(cleanups, dbPath, work) {
  resetWorkDir(work);
  const argv = seedArgs(process.argv.slice(2), process.env, existsSync);
  const seed = seedDbPath(argv);
  if (seed && existsSync(seed)) {
    copyFileSync(seed, work.db);
    console.error(`seeded the graph from ${seed}`);
  }
  const log = (m) => console.error(m);
  const runWorker = async (workerArgv) => {
    const outcome = {};
    const args = [WORKER_FLAG, WORK_DIR_FLAG, work.dir, ...workerArgv];
    const code = await runCappedWorker({ script: SCRIPT, args, name: "dag-check indexer", heapCapMb: HEAP_CAP_MB, cleanups, log, outcome });
    return { code, heapAbort: outcome.heapAbort };
  };
  const code = await runWithColdRetry({ argv, runWorker, clearWork: () => resetWorkDir(work), log });
  if (dbPath) keepDb({ workDb: work.db, dbPath, code });
  if (usesMachineSeed(process.argv.slice(2), process.env)) refreshMachineSeed(work.db, code);
  return code;
}

async function supervise() {
  if (!existsSync(ENTRY)) {
    console.error(`${ENTRY} not found; run pnpm build first`);
    return 2;
  }
  const dbPath = keptDbPath(process.argv.slice(2));
  const cleanups = [];
  cleanupOnSignal(cleanups);
  let hold;
  try {
    hold = await acquire({ slots: lockSlots(), check: "dag:check", timeoutMs: lockWaitMs(), log: (m) => console.error(m) });
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    console.error(err.message);
    return BUSY_EXIT_CODE;
  }
  const work = workPaths(workDirFor(hold.slot));
  cleanups.push(() => release(DEFAULT_LOCK_DIR, hold), () => clearWorkDir(work));
  try {
    hold.exit = await indexUnderLock(cleanups, dbPath, work);
    return hold.exit;
  } finally {
    runCleanups(cleanups);
  }
}

if (process.argv[1] === SCRIPT) {
  (process.argv.includes(WORKER_FLAG) ? check() : supervise()).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
