// A machine-wide warm graph for local dag:check runs, beside the lock (TP-2695 c). Code-graph file ids are repo-relative,
// so a graph any worktree indexed lets the next holder re-parse only the files that differ.
// Every reader and writer runs under the dag-check lock; tmp+rename still keeps a killed refresh from leaving a partial seed.
import { copyFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LOCK_DIR } from "./dag-check-lock.mjs";

export const MACHINE_SEED = path.join(path.dirname(DEFAULT_LOCK_DIR), "dag-check-seed.db");

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
 */
export async function runWithColdRetry({ argv, runWorker, clearWork, log }) {
  const first = await runWorker(argv);
  if (!first.heapAbort || !argv.includes("--seed-db")) return first.code;
  log("seeded index ran out of memory; retrying once without the seed");
  clearWork();
  const at = argv.indexOf("--seed-db");
  const cold = [...argv.slice(0, at), ...argv.slice(at + 2)];
  return (await runWorker(cold)).code;
}
