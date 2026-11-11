// A machine-wide warm graph for local dag:check runs, beside the lock (TP-2695 c). Code-graph file ids are repo-relative,
// so a graph any worktree indexed lets the next holder re-parse only the files that differ.
// Readers and writers hold dag-check lock slots, possibly several at once; tmp+rename means a reader copies a whole seed, old or new,
// and a killed refresh leaves no partial one. Concurrent refreshes race harmlessly: the last finished graph wins.
import { copyFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LOCK_DIR } from "./dag-check-lock.mjs";

export const MACHINE_SEED = path.join(path.dirname(DEFAULT_LOCK_DIR), "dag-check-seed.db");

/**
 * Snapshots a seeded graph keeps for the next run. CI's cache holds one tree's head and its baseline. The machine seed
 * is shared by every worktree and overwritten by whichever run finishes last, so it keeps several recent trees: the
 * indexer reuses whichever matches the tree best, and a worktree's own last run survives a few runs elsewhere (TP-4398).
 */
export function seedKeep(seedPath) {
  return seedPath === MACHINE_SEED ? 8 : 2;
}

/** verify:changed sets this on a dead:check run past its file budget: a cold index there is CI's job, not the local run's. */
export const DEFER_COLD_ENV = "DEAD_CHECK_DEFER_COLD";
/** dead:check's exit when DEFER_COLD_ENV forbade the cold index it would otherwise have fallen back to. */
export const COLD_DEFERRED_EXIT_CODE = 76;

/** True when this run owns the machine seed: no explicit --seed-db (CI keeps its own cache) and no opt-out. */
export function usesMachineSeed(argv, env) {
  return !argv.includes("--seed-db") && !env.DAG_CHECK_NO_SEED;
}

/** argv with `--seed-db <seedPath>` appended when this run uses the machine seed and one exists. */
export function seedArgs(argv, env, exists, seedPath = MACHINE_SEED) {
  return usesMachineSeed(argv, env) && exists(seedPath) ? [...argv, "--seed-db", seedPath] : argv;
}

/** Replaces the seed with a finished graph; exit 2 (an OOM or a crash) may have left a partial graph and keeps the old seed. */
export function refreshSeed({ workDb, seedPath = MACHINE_SEED, code }) {
  if (code !== 0 && code !== 1) return false;
  const tmp = `${seedPath}.tmp-${process.pid}`;
  try {
    copyFileSync(workDb, tmp);
    renameSync(tmp, seedPath);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Runs the indexer; when it hits the heap cap on a seeded graph, clears the work dir and runs it once more cold.
 * A seed carries every snapshot it ever held, so it can need more heap than the cold index it speeds up.
 * `seeded` names a seed the caller copied itself, so no --seed-db marker has to ride in argv.
 */
export async function runWithColdRetry({ argv, runWorker, clearWork, log, deferCold = false, seeded = argv.includes("--seed-db") }) {
  const first = await runWorker(argv);
  if (!first.heapAbort || !seeded) return first.code;
  if (deferCold) {
    log("seeded index ran out of memory; not retrying cold, deferred to CI (run pnpm dag:check to rebuild the seed)");
    return COLD_DEFERRED_EXIT_CODE;
  }
  log("seeded index ran out of memory; retrying once without the seed");
  clearWork();
  const at = argv.indexOf("--seed-db");
  const cold = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  return (await runWorker(cold)).code;
}

/** Thrown by the seeded opener when DEFER_COLD_ENV forbade the cold index it would have fallen back to. */
export class ColdFallbackDeferred extends Error {}

/** Removes a graph database with its WAL and shared-memory sidecars. */
export function removeDb(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
}

/**
 * A seeded snapshot may feed the reuse basis but never snapshot identity: with a commit it becomes the alias base
 * of the head index, so rename aliases (and the baseline's carry-over) would differ from a cold run's.
 */
export function forgetSeedCommits(store) {
  store.db.prepare("UPDATE snapshot SET commit_hash = NULL").run();
}

/**
 * Opens the work graph a seed was copied to. A seed written by another schema or truncated mid-save costs a cold index,
 * never a failed check: the half-opened store is closed, its files removed, and an empty graph opened (or, with
 * deferCold, ColdFallbackDeferred thrown). A usable seed has its snapshot commits cleared.
 */
export function openSeededWorkGraph(graph, dbPath, { deferCold = false } = {}) {
  let store;
  try {
    store = graph.openCodeGraph(dbPath);
    store.listSnapshots({ limit: 1 });
    forgetSeedCommits(store);
    return store;
  } catch (err) {
    console.error(`seed graph unusable, indexing cold: ${err instanceof Error ? err.message : String(err)}`);
    // A db that opens but fails to read is still held open; its files must not be removed under it.
    store?.close();
    removeDb(dbPath);
    if (deferCold) throw new ColdFallbackDeferred("seed graph unusable; cold index deferred to CI (run pnpm dag:check to rebuild the seed)");
    return graph.openCodeGraph(dbPath);
  }
}
