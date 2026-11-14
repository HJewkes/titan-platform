import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../deploy-ports.js";
import type { CommandResult } from "../run-command.js";
import { scrubbedEnv } from "./lockfile-regen.js";
import type { StepRoute } from "@titan-design/workflow";
import { CLOSURE_LOCK_PATH, ClosureRegenFailure, lockRegenRoute, type ClosureRegen, type LockRegenDeps } from "./lock-regen.js";
import type { ShepherdDeps } from "./phases.js";
import { must, type Git } from "./tree-carry.js";

type Run = (file: string, args: readonly string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;

const STEP_TIMEOUT_MS = 15 * 60_000;

/** `registry:closure --write` reads the factory's built closure walk, so the factory and what it imports are built first. */
const REGEN_COMMANDS: readonly (readonly [label: string, file: string, args: readonly string[]])[] = [
  ["install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]],
  ["build", "pnpm", ["--filter", "@titan-design/factory...", "run", "build"]],
  ["registry:closure --write", process.execPath, ["scripts/step-closure-check.mjs", "--write"]],
  ["git add", "git", ["add", "--", CLOSURE_LOCK_PATH]],
  ["git write-tree", "git", ["write-tree"]],
];

/** Only the command's label and exit code are kept: output can echo paths or tokens, and the reason reaches a public PR. */
async function runAll(run: Run, dir: string, signal?: AbortSignal): Promise<string> {
  const env = scrubbedEnv(dir);
  let last = "";
  for (const [label, file, args] of REGEN_COMMANDS) {
    signal?.throwIfAborted();
    const result = await run(file, args, dir, STEP_TIMEOUT_MS, env);
    if (result.code !== 0) throw new ClosureRegenFailure(label, result.code);
    last = result.stdout.trim();
  }
  return last;
}

/**
 * Checks the merge out as a linked worktree of the bare cache, rebuilds the lock there with the tree's own scripts and an
 * environment stripped of credentials, and writes the tree with that lock staged. The checkout is removed either way.
 */
export function scratchClosureRegen(git: Git, run: Run = runCommand): ClosureRegen {
  return async ({ gitDir, commit }, signal) => {
    const dir = mkdtempSync(join(tmpdir(), "closure-regen-"));
    try {
      await must(git, gitDir, ["worktree", "add", "--detach", "--quiet", dir, commit], signal);
      return await runAll(run, dir, signal);
    } finally {
      await git(gitDir, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
      await git(gitDir, ["worktree", "prune"]);
    }
  };
}

/** The lock regeneration a conflict tries before its fixer wake (TP-5732), over Shepherd's own git cache. */
export function hostLockRegenRoute(deps: Pick<ShepherdDeps, "port" | "gitCache" | "advisory" | "closureRegen" | "now">): StepRoute {
  const regen = deps.closureRegen ?? scratchClosureRegen(deps.gitCache.git);
  const regenDeps: LockRegenDeps = { port: deps.port, ports: deps.gitCache, regen, ...(deps.advisory && { advisory: deps.advisory }) };
  return lockRegenRoute(deps.now, regenDeps);
}
