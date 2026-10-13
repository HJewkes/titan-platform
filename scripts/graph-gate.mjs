#!/usr/bin/env node
// `pnpm dag:check`: the DAG check, then dead:check on the graph it kept, so the local gate matches CI's dag-check job (TP-2666).
// Args pass to dag-check-self.mjs (`pnpm dag:check:graph` is that check alone, and the form for --json consumers).
// Without --db the graph goes to a temp dir removed afterwards. With BASE_REF unset, dead:check alone gets
// BASE_REF=origin/main for its baseline-growth check; dag-check would spend a second full index on it.
// Exit: dag's 2 or 75 skips dead:check (no graph was kept); else dead's 2 or 75; else 1 if either found something.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keptDbPath } from "./dag-check-self.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const DEFAULT_BASE_REF = "origin/main";
const FAILED_TO_RUN = new Set([2, 75]);

export function gateArgs(argv, tmpDb) {
  const kept = keptDbPath(argv);
  return kept ? { dagArgs: argv, dbPath: kept } : { dagArgs: [...argv, "--db", tmpDb], dbPath: tmpDb };
}

export function deadEnv(env, baseRefExists) {
  if (env.BASE_REF !== undefined || !baseRefExists) return env;
  return { ...env, BASE_REF: DEFAULT_BASE_REF };
}

export function combineExits(dag, dead) {
  if (FAILED_TO_RUN.has(dag)) return dag;
  if (FAILED_TO_RUN.has(dead)) return dead;
  return dag === 0 && dead === 0 ? 0 : 1;
}

function refExists(ref, cwd) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runNode(script, args, env, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: "inherit" });
  return r.status ?? 2;
}

export function runGate({ dagScript, deadScript, argv, env, cwd = ROOT }) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "graph-gate-"));
  try {
    const { dagArgs, dbPath } = gateArgs(argv, path.join(tmpDir, "graph.db"));
    const dag = runNode(dagScript, dagArgs, env, cwd);
    if (FAILED_TO_RUN.has(dag)) return dag;
    const dead = runNode(deadScript, ["--db", dbPath], deadEnv(env, refExists(DEFAULT_BASE_REF, cwd)), cwd);
    return combineExits(dag, dead);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === SCRIPT) {
  const scripts = { dagScript: path.join(ROOT, "scripts/dag-check-self.mjs"), deadScript: path.join(ROOT, "scripts/dead-code-check.mjs") };
  process.exit(runGate({ ...scripts, argv: process.argv.slice(2), env: process.env }));
}
