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

// Earlier releases exported this exact list for a caller who set none, so it reads as unset (CC-1336).
const LEGACY_GIT_PROTOCOL_PIN = SAFE_GIT_PROTOCOLS.join(':')

/**
 * The caller's GIT_ALLOW_PROTOCOL narrowed to the safe list, or undefined (leave it unset) when the
 * caller set none or the legacy full list. git reads an exported list over every `protocol.*.allow`
 * config, so exporting one for a caller who never chose it would lift their own denies (CC-1336).
 * A caller list with nothing safe in it (`ext` alone) gives '', which git reads as allowing no transport.
 */
export function pinGitProtocols(value: string | undefined): string | undefined {
  if (value === undefined || value === LEGACY_GIT_PROTOCOL_PIN) return undefined
  return value
    .split(':')
    .filter(name => SAFE_GIT_PROTOCOLS.includes(name))
    .join(':')
}

const EXT_NEVER_KEY = 'protocol.ext.allow'
const EXT_NEVER_VALUE = 'never'

// git dies on a count it cannot parse or a pair missing below it, so refusing here loses nothing.
function configCount(env: NodeJS.ProcessEnv): number {
  const raw = env.GIT_CONFIG_COUNT ?? ''
  if (!/^\d{0,9}$/.test(raw)) throw new Error(`GIT_CONFIG_COUNT ${JSON.stringify(raw)} is not a count git reads`)
  const count = Number(raw)
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === undefined || env[`GIT_CONFIG_VALUE_${i}`] === undefined)
      throw new Error(`GIT_CONFIG_COUNT is ${count} but GIT_CONFIG_KEY_${i} or GIT_CONFIG_VALUE_${i} is unset`)
  }
  return count
}

/**
 * `env` with `protocol.ext.allow=never` as its last command-scope config pair. That pair outranks
 * every config file and include and any `protocol.allow`, and only the caller's own `-c` beats it,
 * so `ext::` stays off while git reads every other protocol policy itself (CC-1095, CC-1336).
 */
function withExtNeverPair(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = configCount(env)
  const last = count - 1
  if (count > 0 && env[`GIT_CONFIG_KEY_${last}`] === EXT_NEVER_KEY && env[`GIT_CONFIG_VALUE_${last}`] === EXT_NEVER_VALUE)
    return env
  return {
    ...env,
    [`GIT_CONFIG_KEY_${count}`]: EXT_NEVER_KEY,
    [`GIT_CONFIG_VALUE_${count}`]: EXT_NEVER_VALUE,
    GIT_CONFIG_COUNT: String(count + 1),
  }
}

function pinnedGitEnv(env: NodeJS.ProcessEnv, protocols: string | undefined): NodeJS.ProcessEnv {
  const out = { ...env }
  if (protocols === undefined) delete out.GIT_ALLOW_PROTOCOL
  else out.GIT_ALLOW_PROTOCOL = protocols
  return withExtNeverPair(out)
}

/** `env` with the transport pin, for a child that may run git without going through `gitChildEnv`. */
export function withPinnedGitProtocols(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return pinnedGitEnv(env, pinGitProtocols(env.GIT_ALLOW_PROTOCOL))
}


/** A git child that inherits a dispatcher's identity variables can register as the agent that spawned it. */
export const DEFAULT_STRIPPED_ENV_PREFIXES: readonly string[] = ["AGENT_CHAT_"];

export function gitChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  stripPrefixes: readonly string[] = DEFAULT_STRIPPED_ENV_PREFIXES
): NodeJS.ProcessEnv {
  const protocols = pinGitProtocols(env.GIT_ALLOW_PROTOCOL);
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(out)) {
    if (stripPrefixes.some((prefix) => key.startsWith(prefix))) delete out[key];
  }
  // Pinned after stripping, so a GIT_ strip cannot erase the ext pair or widen the original caller list.
  return pinnedGitEnv(out, protocols);
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
