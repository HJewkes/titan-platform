import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../deploy-ports.js";
import type { CommandResult } from "../run-command.js";
import type { StepRoute } from "@titan-design/workflow";
import { nodeInstallDir, readSandboxLock, SANDBOX_STEPS, sandboxArgs, type SandboxPaths } from "./closure-sandbox.js";
import { CLOSURE_LOCK_PATH, ClosureRegenFailure, lockRegenRoute, type ClosureRegen, type LockRegenDeps } from "./lock-regen.js";
import type { ShepherdDeps } from "./phases.js";
import { must, type Git } from "./tree-carry.js";

type Run = (file: string, args: readonly string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;

const STEP_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
/** bwrap itself needs nothing from the host's environment: the sandbox's own is built with --clearenv. */
const BWRAP_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

interface Scratch extends SandboxPaths {
  root: string;
}

function scratchDirs(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "closure-regen-"));
  const paths = { root, work: join(root, "work"), home: join(root, "home"), tar: join(root, "merge.tar"), nodeDir: nodeInstallDir(process.execPath) };
  mkdirSync(paths.work);
  mkdirSync(paths.home);
  return paths;
}

/** Only the command's label and exit code are kept: output can echo paths or tokens, and the reason reaches a public PR. */
async function runSandboxed(run: Run, paths: Scratch, signal?: AbortSignal): Promise<void> {
  for (const step of SANDBOX_STEPS) {
    signal?.throwIfAborted();
    const result = await run("bwrap", sandboxArgs(paths, step), paths.root, STEP_TIMEOUT_MS, BWRAP_ENV);
    if (result.code !== 0) throw new ClosureRegenFailure(`${step.label} exited ${result.code}`);
  }
}

/**
 * Shepherd writes the tree itself, from the merge's tree with only the lock's blob swapped, through a private index
 * file, so nothing the sandbox did reaches the cache except the lock's validated text.
 */
async function treeWithLock(run: Run, gitDir: string, commit: string, lock: string, root: string): Promise<string> {
  const lockFile = join(root, "closure.lock.json");
  writeFileSync(lockFile, lock);
  const env = { ...BWRAP_ENV, GIT_DIR: gitDir, GIT_INDEX_FILE: join(root, "index") };
  const git = async (label: string, args: readonly string[]): Promise<string> => {
    const result = await run("git", args, root, GIT_TIMEOUT_MS, env);
    if (result.code !== 0) throw new ClosureRegenFailure(`git ${label} exited ${result.code}`);
    return result.stdout.trim();
  };
  const blob = await git("hash-object", ["hash-object", "-w", "--no-filters", "--", lockFile]);
  await git("read-tree", ["read-tree", commit]);
  await git("update-index", ["update-index", "--add", "--cacheinfo", `100644,${blob},${CLOSURE_LOCK_PATH}`]);
  return git("write-tree", ["write-tree"]);
}

/** A sandbox can leave directories it made unwritable; they are opened up first so the scratch tree always goes. */
async function removeScratch(run: Run, root: string): Promise<void> {
  await run("chmod", ["-R", "u+rwX", root], tmpdir(), GIT_TIMEOUT_MS, BWRAP_ENV);
  rmSync(root, { recursive: true, force: true });
}

/**
 * Exports the merge from the cache as a tar, so the sandbox sees no git directory, and rebuilds the lock inside the
 * sandbox with the merge's own scripts. The scratch tree is removed either way.
 */
export function sandboxedClosureRegen(git: Git, run: Run = runCommand): ClosureRegen {
  return async ({ gitDir, commit }, signal) => {
    const scratch = scratchDirs();
    try {
      await must(git, gitDir, ["archive", "--format=tar", "-o", scratch.tar, commit], signal);
      await runSandboxed(run, scratch, signal);
      return await treeWithLock(run, gitDir, commit, readSandboxLock(scratch.work), scratch.root);
    } finally {
      await removeScratch(run, scratch.root);
    }
  };
}

/** The lock regeneration a conflict tries before its fixer wake (TP-5732), over Shepherd's own git cache. */
export function hostLockRegenRoute(deps: Pick<ShepherdDeps, "port" | "gitCache" | "advisory" | "closureRegen" | "now">): StepRoute {
  const regen = deps.closureRegen ?? sandboxedClosureRegen(deps.gitCache.git);
  const regenDeps: LockRegenDeps = { port: deps.port, ports: deps.gitCache, regen, ...(deps.advisory && { advisory: deps.advisory }) };
  return lockRegenRoute(deps.now, regenDeps);
}
