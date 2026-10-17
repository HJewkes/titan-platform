import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * One `git` invocation, returning null rather than throwing.
 *
 * git failures are routine control flow here: "is this a repository at all" is
 * a failing command, and every caller treats a miss as an answer. Injectable so
 * tests of callers never shell out.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;

/** The transports git may use for agent-chat and its agents; `ext::` runs a shell command (CC-1095). */
export const SAFE_GIT_PROTOCOLS: readonly string[] = ['file', 'git', 'http', 'https', 'ssh']

/**
 * The caller's GIT_ALLOW_PROTOCOL narrowed to the safe list, or the whole safe list when unset.
 * git reads this list over every `protocol.*.allow` config scope, so a repo's config cannot re-enable `ext`.
 * A caller list with nothing safe in it (`ext` alone) gives '', which git reads as allowing no transport.
 */
export function pinGitProtocols(value: string | undefined): string {
  if (value === undefined) return SAFE_GIT_PROTOCOLS.join(':')
  return value
    .split(':')
    .filter(name => SAFE_GIT_PROTOCOLS.includes(name))
    .join(':')
}

/** `env` with GIT_ALLOW_PROTOCOL pinned, for a child that may run git without going through `gitChildEnv`. */
export function withPinnedGitProtocols(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_ALLOW_PROTOCOL: pinGitProtocols(env.GIT_ALLOW_PROTOCOL) }
}


/** A git child that inherits a dispatcher's identity variables can register as the agent that spawned it. */
export const DEFAULT_STRIPPED_ENV_PREFIXES: readonly string[] = ["AGENT_CHAT_"];

export function gitChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  stripPrefixes: readonly string[] = DEFAULT_STRIPPED_ENV_PREFIXES
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: pinGitProtocols(env.GIT_ALLOW_PROTOCOL) };
  for (const key of Object.keys(out)) {
    if (stripPrefixes.some((prefix) => key.startsWith(prefix))) delete out[key];
  }
  return out;
}

/** Throws on a non-zero exit; `stderr` and `code` ride on the error. */
export async function gitText(args: readonly string[], cwd: string, timeout?: number): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: gitChildEnv(),
    ...(timeout === undefined ? {} : { timeout }),
  });
  return stdout.trim();
}

export async function gitOrNull(args: readonly string[], cwd: string, timeout?: number): Promise<string | null> {
  try {
    return await gitText(args, cwd, timeout);
  } catch {
    return null;
  }
}

export const runGit: GitRunner = (args, cwd) => gitOrNull(args, cwd);

/**
 * The true repository root, resolved through worktrees.
 *
 * `--git-common-dir` rather than `--show-toplevel`: from inside a worktree the
 * toplevel is that worktree, and allocating from it would nest worktrees.
 */
export async function findGitRoot(cwd: string, git: GitRunner = runGit): Promise<string | null> {
  const commonDir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return commonDir === null ? null : path.dirname(commonDir);
}

/** Where a process is observably running, as git sees it, as opposed to what it says about itself. */
export interface GitPresence {
  gitBranch?: string;
  /** The checkout this process's files live in. */
  worktreePath?: string;
  /** The repository behind the checkout; two worktrees of one repo share it. */
  repoPath?: string;
  isLinkedWorktree?: boolean;
}

/**
 * Undefined outside a git repository. The toplevel and the common dir answer
 * different questions: when they disagree, this is a linked worktree.
 */
export async function observedPresence(cwd: string, git: GitRunner = runGit): Promise<GitPresence | undefined> {
  const [branch, toplevel, commonDir, gitDir] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["rev-parse", "--show-toplevel"], cwd),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
    git(["rev-parse", "--path-format=absolute", "--git-dir"], cwd),
  ]);
  if (toplevel === null && commonDir === null) return undefined;

  const observed: GitPresence = {
    // 'HEAD' means detached, which is not a branch name.
    ...(branch !== null && branch !== "" && branch !== "HEAD" ? { gitBranch: branch } : {}),
    ...(toplevel === null || toplevel === "" ? {} : { worktreePath: toplevel }),
    ...(commonDir === null ? {} : { repoPath: path.dirname(path.resolve(commonDir)) }),
    ...(commonDir === null || gitDir === null
      ? {}
      : { isLinkedWorktree: path.resolve(commonDir) !== path.resolve(gitDir) }),
  };
  return Object.keys(observed).length === 0 ? undefined : observed;
}
