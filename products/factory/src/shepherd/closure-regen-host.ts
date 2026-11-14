import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../deploy-ports.js";
import type { CommandResult } from "../run-command.js";
import { scrubbedEnv } from "./lockfile-regen.js";
import { CLOSURE_LOCK_PATH, type ClosureRegen, type LockRegenDeps } from "./lock-regen.js";
import type { ShepherdDeps } from "./phases.js";
import { must, type Git } from "./tree-carry.js";

type Run = (file: string, args: readonly string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;

const STEP_TIMEOUT_MS = 15 * 60_000;

/** `registry:closure --write` reads the factory's built closure walk, so the factory and what it imports are built first. */
const REGEN_COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ["pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]],
  ["pnpm", ["--filter", "@titan-design/factory...", "run", "build"]],
  [process.execPath, ["scripts/step-closure-check.mjs", "--write"]],
  ["git", ["add", "--", CLOSURE_LOCK_PATH]],
  ["git", ["write-tree"]],
];

/** Only the command and exit code are kept: output can echo paths or tokens, and the reason reaches a public PR. */
async function runAll(run: Run, dir: string, signal?: AbortSignal): Promise<string> {
  const env = scrubbedEnv(dir);
  let last = "";
  for (const [file, args] of REGEN_COMMANDS) {
    signal?.throwIfAborted();
    const result = await run(file, args, dir, STEP_TIMEOUT_MS, env);
    if (result.code !== 0) throw new Error(`closure regen: ${args.slice(0, 2).join(" ")} exited ${result.code}`);
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

export function lockRegenDeps(deps: Pick<ShepherdDeps, "port" | "gitCache" | "advisory" | "closureRegen">): LockRegenDeps {
  const regen = deps.closureRegen ?? scratchClosureRegen(deps.gitCache.git);
  return { port: deps.port, ports: deps.gitCache, regen, ...(deps.advisory && { advisory: deps.advisory }) };
}
