import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FIND_REPO_HOOK,
  prePushScript,
  WRITTEN_BY,
  withoutShimDirs,
  type Bake,
  type HookShell,
  type ScanInputs,
  type ScannerFacts,
  type ScanVerdict,
} from "./pre-push.js";

/**
 * Client hooks shimmed to chain to the repo's own hook, since overriding the hooks path hides it.
 * Each shim costs a shell and a git call, so the hooks that fire on every commit without gating it
 * (`reference-transaction`, `post-index-change`, `prepare-commit-msg`, `post-commit`) are not
 * chained and do not run for agents. Server-side names never run in an agent's repo.
 */
export const CHAINED_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "commit-msg",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "pre-auto-gc",
  "sendemail-validate",
] as const;

const HOOKS_PATH_KEY = "core.hooksPath";

/** Command-scope git config through the environment, so no repo's `.git/config` is written. */
export const gitHooksEnv = (dir: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: HOOKS_PATH_KEY,
  GIT_CONFIG_VALUE_0: dir,
});

/** The guard dir a launch env points git at, if any. */
export const hooksDirOf = (env: Record<string, string>): string | undefined =>
  env.GIT_CONFIG_COUNT === "1" && env.GIT_CONFIG_KEY_0 === HOOKS_PATH_KEY ? env.GIT_CONFIG_VALUE_0 : undefined;

const chainShim = (shell: HookShell): string => `#!${shell.path}\n${WRITTEN_BY}${shell.scrub}${FIND_REPO_HOOK}\n[ -n "$hook" ] || exit 0\nexec "$hook" "$@"\n`;

const SCANNER = "titan-egress-scan";
const PROBE_TIMEOUT_MS = 5000;

const executableOnPath = (name: string, searchPath: string): string | undefined =>
  searchPath
    .split(":")
    .map((dir) => path.join(dir, name))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });

const verdictOf = (help: string): ScanVerdict =>
  !help.includes("pre-push") ? "no-pre-push" : help.includes("scanned as text") ? "scans-text" : "skips-binary";

/**
 * `test -nt` in dash and bash 3.2 compares whole seconds, so a scanner replaced within the second
 * it was probed in would pass the push-time check. A scanner written this recently is not baked;
 * any later npm install then lands in a later second, and the check sees it.
 */
const SETTLED_MS = 2000;

// SIGKILL, since the broker waits on this run and a scanner may ignore SIGTERM.
function helpText(node: string, scanner: string, bakedPath: string): string | undefined {
  const run = spawnSync(node, [scanner, "--help"], {
    env: { PATH: bakedPath },
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // A timeout sets error even when the scanner exited 0 and a grandchild held its output open.
  if (run.error !== undefined || run.signal !== null || run.status !== 0) return undefined;
  return `${run.stdout}${run.stderr}`;
}

/**
 * Runs the scanner's --help once, the way the hook would, with an environment of PATH alone. A
 * scanner or node that is missing, a help run that fails, is killed or times out, a scanner
 * written within the last two seconds, or one whose mtime moved during the run yields nothing,
 * so the hook keeps checking at every push.
 */
export function probeScanner(bakedPath: string): ScannerFacts | undefined {
  const found = executableOnPath(SCANNER, bakedPath);
  const node = executableOnPath("node", bakedPath);
  if (found === undefined || node === undefined) return undefined;
  try {
    const scanner = fs.realpathSync(found);
    const { mtimeMs } = fs.statSync(scanner);
    if (Date.now() - mtimeMs < SETTLED_MS) return undefined;
    const help = helpText(node, scanner, bakedPath);
    if (help === undefined || fs.statSync(scanner).mtimeMs !== mtimeMs) return undefined;
    return { scanner, node, verdict: verdictOf(help), mtimeMs };
  } catch {
    return undefined;
  }
}

// os.userInfo() reads the passwd entry, not $HOME; os.homedir() is the fallback when there is none.
export function passwdHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/** Where the writer puts each hook: the shell they name and the shim dirs their PATH leaves out. */
export interface HookSetup {
  readonly shell: HookShell;
  /** The agent's git and gh shim dirs; the hook never pushes, so its git calls skip them. */
  readonly shimDirs: readonly string[];
}

/** Every hook the dir holds, by name: the scanning pre-push and a chain shim per `CHAINED_HOOKS` entry. */
export function hookScripts(inputs: ScanInputs, { shell, shimDirs }: HookSetup, bake?: Bake, noRewrite = false): Map<string, string> {
  return new Map([
    ["pre-push", prePushScript({ inputs, shell, shimDirs, bake, noRewrite })],
    ...CHAINED_HOOKS.map((name) => [name, chainShim(shell)] as const),
  ]);
}

/** Replaced by rename, so a hook git is running at that moment never reads a half-written file. */
function writeIfChanged(file: string, body: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === body && (fs.statSync(file).mode & 0o777) === 0o755) return;
  } catch {
    // Absent: write it below.
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, file);
}

const NO_REWRITE_DIR = "no-rewrite";

/**
 * The hooks dir a `no-rewrite` profile's git runs with (CC-1633): under the guard's own dir, so the
 * pretool's protected path covers it, and with its own git shim dir beside it.
 */
export const noRewriteHooksDir = (hooksDir: string): string => path.join(hooksDir, NO_REWRITE_DIR);

/** The dir's name carries the policy, so a plan that selected it rewrites it the same way on resume. */
export const isNoRewriteHooksDir = (dir: string): boolean => path.basename(dir) === NO_REWRITE_DIR;

/** Writes the hooks into `dir`; a dir named by `noRewriteHooksDir` also gets the no-rewrite push policy. */
export function writeGitHooks(dir: string, inputs: ScanInputs, setup: HookSetup): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bake = bakeScanner(inputs, setup.shimDirs, path.join(dir, STAMP_FILE));
  for (const [name, body] of hookScripts(inputs, setup, bake, isNoRewriteHooksDir(dir))) writeIfChanged(path.join(dir, name), body);
}

/** Not a hook name, so git never runs it; only its mtime is read. */
export const STAMP_FILE = "egress-scan.stamp";

/**
 * The stamp is written before the hook that reads it, and removed before a hook without a bake
 * lands, so a hook mid-run never pairs a verdict with a stamp from a scanner it was not found for.
 */
function bakeScanner(inputs: ScanInputs, shimDirs: readonly string[], stamp: string): Bake | undefined {
  const facts = inputs.probe?.(withoutShimDirs(inputs.path, shimDirs));
  if (facts?.verdict !== "scans-text") {
    fs.rmSync(stamp, { force: true });
    return undefined;
  }
  writeStamp(stamp, facts.mtimeMs);
  return { facts, stamp };
}

// utimes takes float seconds, which drops nanoseconds; one ms above the mtime keeps the probed file not newer.
// Shells that compare whole seconds miss a replacement whose mtime is not after the end of the probed second.
function writeStamp(stamp: string, mtimeMs: number): void {
  const tmp = `${stamp}.${process.pid}.tmp`;
  const seconds = (Math.ceil(mtimeMs) + 1) / 1000;
  fs.writeFileSync(tmp, "", { mode: 0o600 });
  fs.utimesSync(tmp, seconds, seconds);
  fs.renameSync(tmp, stamp);
}
