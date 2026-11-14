import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import { CLOSURE_LOCK_PATH, ClosureRegenFailure } from "./lock-regen.js";

/** The scratch directories a regeneration mounts into its sandbox, all on the host. */
export interface SandboxPaths {
  work: string;
  home: string;
  tar: string;
  /** The node install the sandbox runs, mounted read-only at the same path. */
  nodeDir: string;
}

interface SandboxStep {
  label: string;
  net: boolean;
  file: string;
  args: readonly string[];
}

const WORK = "/work";
const HOME = "/sandbox-home";
const INPUT = "/in/merge.tar";
const MAX_LOCK_BYTES = 1_000_000;

/**
 * The merge's own scripts run here and nowhere else. Only `install`, which runs no package script, reaches the network;
 * the build and the lock write run offline, so whatever the branch ships cannot send anything out.
 */
export const SANDBOX_STEPS: readonly SandboxStep[] = [
  { label: "unpack", net: false, file: "tar", args: ["-xf", INPUT, "-C", WORK] },
  { label: "install", net: true, file: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"] },
  { label: "build", net: false, file: "pnpm", args: ["--filter", "@titan-design/factory...", "run", "build"] },
  { label: "registry:closure --write", net: false, file: "node", args: ["scripts/step-closure-check.mjs", "--write"] },
];

/**
 * bwrap with every namespace unshared and an environment built from nothing: the host's home, its git cache, its
 * credentials and its environment are not mounted or passed, and the scratch tree is the only writable host path.
 */
export function sandboxArgs(paths: SandboxPaths, step: SandboxStep): string[] {
  const system = ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--ro-bind", "/etc", "/etc"];
  const dns = step.net ? ["--share-net", "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve"] : [];
  const scratch = ["--bind", paths.home, HOME, "--bind", paths.work, WORK, "--ro-bind", paths.tar, INPUT];
  const mounts = ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", paths.nodeDir, paths.nodeDir, ...scratch];
  const path = `${join(paths.nodeDir, "bin")}:/usr/bin:/bin`;
  const env = ["--clearenv", "--setenv", "HOME", HOME, "--setenv", "PATH", path, "--setenv", "TMPDIR", "/tmp", "--setenv", "CI", "1", "--setenv", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "0"];
  return ["--die-with-parent", "--new-session", "--unshare-all", ...dns, ...system, ...mounts, ...env, "--chdir", WORK, "--", step.file, ...step.args];
}

/** The install holding `execPath`: its `bin/node` is what the sandbox's `node` and pnpm's shebang resolve to. */
export const nodeInstallDir = (execPath: string): string => dirname(dirname(realpathSync(execPath)));

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const LockSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), z.strictObject({ closure: Hash, schemaHash: Hash, bump: z.number().int().nonnegative() }));

const refusal = (why: string): ClosureRegenFailure => new ClosureRegenFailure(`the regenerated lock ${why}`);

function parseLock(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw refusal("is not JSON");
  }
}

/**
 * Reads the lock as data only after the sandbox has exited. A symlink out of the scratch tree, an oversized file or any
 * field the lock does not have is refused, and the text is re-serialized the way closure-main prints it.
 */
export function readSandboxLock(work: string): string {
  const root = realpathSync(work);
  const path = realpathSync(join(work, CLOSURE_LOCK_PATH));
  if (!path.startsWith(`${root}${sep}`)) throw refusal("resolves outside the scratch tree");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) throw refusal("is not a regular file of bounded size");
  const parsed = LockSchema.safeParse(parseLock(readFileSync(path, "utf8")));
  if (!parsed.success) throw refusal("is not a closure lock");
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}
