import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnExec, type Exec } from "@titan-design/fix-proof";
import { assertNoLaterHistory, seedWorkspace } from "../../implement-task/workspace.js";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const COPY_TIMEOUT_MS = 10 * 60_000;

type PrepareVerdict = "ready" | "infra-screen" | "build-failed";

interface PrepareResult {
  verdict: PrepareVerdict;
  /** The failing command's last output, for the case row. */
  detail?: string;
}

interface PrepareOptions {
  /** `<prepared root>/<case id>`; must not exist yet. */
  baseDir: string;
  treeDir: string;
  mergeSha: string;
  exec?: Exec;
}

const tail = (text: string): string => text.trim().split("\n").slice(-5).join("\n");

/**
 * One prepared base per case, made outside every job: a one-commit repo of the base tree, installed from the local
 * store only and built. A base that can reach later history throws, since no arm may ever be copied from it; an
 * install that needs the network is the machine's gap, not the case's, so it reads as `infra-screen`.
 */
export async function prepareBase(options: PrepareOptions): Promise<PrepareResult> {
  const exec = options.exec ?? spawnExec;
  await seedWorkspace(options.treeDir, options.baseDir);
  await assertNoLaterHistory(options.baseDir, options.mergeSha);
  const install = await exec("pnpm", ["install", "--frozen-lockfile", "--offline"], { cwd: options.baseDir, timeoutMs: INSTALL_TIMEOUT_MS });
  if (install.status !== 0) return { verdict: "infra-screen", detail: tail(install.stderr || install.stdout) };
  const build = await exec("pnpm", ["build"], { cwd: options.baseDir, timeoutMs: BUILD_TIMEOUT_MS });
  if (build.status !== 0) return { verdict: "build-failed", detail: tail(build.stderr || build.stdout) };
  return { verdict: "ready" };
}

/** A copy-on-write copy where the disk allows it; never a worktree or shared clone, which would share the merge's objects. */
export async function copyPreparedBase(caseId: string, dest: string, options: { preparedRoot: string; exec?: Exec }): Promise<void> {
  const source = join(options.preparedRoot, caseId);
  if (!existsSync(source)) throw new Error(`no prepared base for ${caseId}`);
  if (existsSync(dest)) throw new Error(`refusing to copy over ${dest}`);
  const exec = options.exec ?? spawnExec;
  const copied = await exec("cp", ["-a", "--reflink=auto", "--", source, dest], { cwd: options.preparedRoot, timeoutMs: COPY_TIMEOUT_MS });
  if (copied.status !== 0) throw new Error(`copy of ${caseId} failed (exit ${copied.status ?? "signal"}): ${tail(copied.stderr)}`);
}
