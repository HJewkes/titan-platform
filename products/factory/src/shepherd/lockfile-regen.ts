import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setupEnv } from "@titan-design/worktree";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { runCommand } from "../deploy-ports.js";
import { redactCredentials, redactHomePaths } from "../redact.js";
import type { CommandResult } from "../run-command.js";

type LockfileKind = "pnpm" | "npm";

/** Every file a lockfile-only install reads, by repo-relative path: manifests, the lockfile, pnpm-workspace.yaml, .npmrc and patches. */
export interface LockfileTree {
  kind: LockfileKind;
  files: Readonly<Record<string, string>>;
}

/** Regenerates the lockfile for edited manifests; resolves to the files whose text changed, by path. */
export type LockfileRegen = (tree: LockfileTree) => Promise<Record<string, string>>;

type Run = (file: string, args: readonly string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;

const REGEN_TIMEOUT_MS = 10 * 60_000;
const ERROR_TAIL_CHARS = 2_000;
const LOCKFILE: Readonly<Record<LockfileKind, string>> = { pnpm: "pnpm-lock.yaml", npm: "package-lock.json" };
const PNPM_ARGS = ["install", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile"];
const NPM_ARGS = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
/** The version reaches corepack's argv, so nothing but a plain version passes; a `+sha` suffix is dropped. */
const PINNED_PNPM = /^pnpm@(\d+\.\d+\.\d+)(?:\+[A-Za-z0-9.]+)?$/;
const TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN"];
/** npm_config_ passes setupEnv's allowlist, and `npm_config_//host/:_authToken` is how npm takes a token from env. */
const CREDENTIAL_ENV = /token|auth|passw|secret/i;
const PNPMFILE = /(?:^|\/)\.?pnpmfile\.[cm]?js$/;

const RootManifest = z.looseObject({
  packageManager: z.string().optional(),
  pnpm: z.looseObject({ patchedDependencies: z.record(z.string(), z.string()).optional() }).optional(),
});
const WorkspaceConfig = z.looseObject({ patchedDependencies: z.record(z.string(), z.string()).optional(), pnpmfile: z.unknown().optional() }).nullable();

export function scratchLockfileRegen(run: Run = runCommand): LockfileRegen {
  return async (tree) => {
    const lockfile = LOCKFILE[tree.kind];
    const before = requiredFile(tree, lockfile);
    const [file, args] = command(tree);
    const dir = mkdtempSync(join(tmpdir(), "lockfile-regen-"));
    try {
      writeTree(dir, tree.files);
      const result = await run(file, args, dir, REGEN_TIMEOUT_MS, scrubbedEnv(dir));
      if (result.code !== 0) throw new Error(`${file} ${args.join(" ")} exited ${result.code}: ${outputTail(result)}`);
      const after = readFileSync(join(dir, lockfile), "utf8");
      assertSameLockfileVersion(tree.kind, before, after);
      return after === before ? {} : { [lockfile]: after };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Refuses before anything runs: a pnpmfile is code pnpm loads, and an unread patch file fails the install mid-way. */
function command(tree: LockfileTree): [string, readonly string[]] {
  const root = RootManifest.parse(JSON.parse(requiredFile(tree, "package.json")));
  if (tree.kind === "npm") return ["npm", NPM_ARGS];
  refuseUntrustedPnpmInputs(tree, root);
  if (root.packageManager === undefined) return ["pnpm", PNPM_ARGS];
  const pinned = PINNED_PNPM.exec(root.packageManager);
  if (!pinned) throw new Error(`packageManager ${JSON.stringify(root.packageManager)} is not a plain pnpm@x.y.z pin`);
  return ["corepack", [`pnpm@${pinned[1]}`, ...PNPM_ARGS]];
}

function refuseUntrustedPnpmInputs(tree: LockfileTree, root: z.infer<typeof RootManifest>): void {
  const pnpmfile = Object.keys(tree.files).find((path) => PNPMFILE.test(path));
  if (pnpmfile !== undefined) throw new Error(`refusing a tree with ${pnpmfile}: pnpm would load it as code`);
  const workspaceText = tree.files["pnpm-workspace.yaml"];
  const workspace = workspaceText === undefined ? null : WorkspaceConfig.parse(parseYaml(workspaceText));
  if (workspace?.pnpmfile !== undefined) throw new Error("refusing a tree whose pnpm-workspace.yaml names a pnpmfile");
  const patches = [...Object.values(root.pnpm?.patchedDependencies ?? {}), ...Object.values(workspace?.patchedDependencies ?? {})];
  const unread = patches.filter((path) => tree.files[path] === undefined);
  if (unread.length > 0) throw new Error(`refusing a tree with unread patch files: ${unread.join(", ")}`);
}

function requiredFile(tree: LockfileTree, path: string): string {
  const text = tree.files[path];
  if (text === undefined) throw new Error(`the tree has no ${path}`);
  return text;
}

function writeTree(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "" || part === ".")) throw new Error(`refusing tree path ${JSON.stringify(path)}`);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** setupEnv is the install allowlist; this also drops tokens it lets through and points npm's user config at an empty file, so ~/.npmrc lends no credential. */
function scrubbedEnv(dir: string): NodeJS.ProcessEnv {
  const userconfig = join(dir, ".lockfile-regen-userconfig");
  writeFileSync(userconfig, "");
  const env = Object.fromEntries(Object.entries(setupEnv(process.env)).filter(([key]) => !TOKEN_ENV.includes(key) && !CREDENTIAL_ENV.test(key)));
  return { ...env, npm_config_userconfig: userconfig, NPM_CONFIG_USERCONFIG: userconfig };
}

/** pnpm prints a failure on stdout and leaves stderr empty, so both streams are kept, scrubbed of credentials and home paths. */
function outputTail(result: CommandResult): string {
  const text = redactHomePaths(redactCredentials([result.stderr, result.stdout].filter((part) => part.trim() !== "").join("\n").trim()));
  return text.length <= ERROR_TAIL_CHARS ? text : `… ${text.slice(-ERROR_TAIL_CHARS)}`;
}

/** A new lockfileVersion rewrites every entry, so the bump PR would churn the whole file. */
function assertSameLockfileVersion(kind: LockfileKind, before: string, after: string): void {
  const was = lockfileVersion(kind, before);
  const now = lockfileVersion(kind, after);
  if (was !== now) throw new Error(`lockfileVersion changed from ${was} to ${now}`);
}

function lockfileVersion(kind: LockfileKind, text: string): string {
  if (kind === "npm") return String(z.looseObject({ lockfileVersion: z.number() }).parse(JSON.parse(text)).lockfileVersion);
  const match = /^lockfileVersion:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
  if (!match?.[1]) throw new Error("pnpm-lock.yaml has no lockfileVersion");
  return match[1];
}
