import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { gitChildEnv, gitOrNull, gitText } from "./git.js";
import { groupAlive, signalGroup } from "./process-group.js";

/** Runs one `git worktree add`, resolving to its output and rejecting on failure. */
export type WorktreeAddRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** Five minutes: a cold checkout of a multi-gigabyte repo takes tens of seconds, so only a hang reaches it. */
export const WORKTREE_ADD_TIMEOUT_MS = 300_000;

const CLEANUP_TIMEOUT_MS = 30_000;
/** SIGTERM first so git can drop its lock files; SIGKILL follows for whatever ignores it. */
const TERM_GRACE_MS = 1_000;

/** The tail of each repo's queue of `worktree add`s; it never rejects, so one failure does not jam the rest. */
const addQueues = new Map<string, Promise<unknown>>();

/** Concurrent adds in one repo read each other's half-written `.git/worktrees/<name>/commondir` and die. */
export function addWorktree(
  gitRoot: string,
  args: readonly string[],
  run: WorktreeAddRunner = gitText
): Promise<string> {
  const adding = (addQueues.get(gitRoot) ?? Promise.resolve()).then(() => run(args, gitRoot));
  const tail = adding.catch(() => undefined);
  addQueues.set(gitRoot, tail);
  void tail.then(() => addQueues.get(gitRoot) === tail && addQueues.delete(gitRoot));
  return adding;
}

const addTarget = (args: readonly string[]): string | undefined => (args[2] === "-b" ? args[4] : args[2]);

class AddTimedOut extends Error {}

async function reapGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGKILL");
  for (let i = 0; i < 100 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 20));
}

function settleAdd(code: number | null, out: string, err: string): Error | string {
  if (code === 0) return out.trim();
  return Object.assign(new Error(err.trim() || `git exited with code ${code}`), { code, stderr: err });
}

/**
 * Run git in its own process group, so a timeout can kill the hooks and filters
 * it spawned and not only git itself. Settles only after the child has exited and
 * the group is reaped, so cleanup never races a process that can still write.
 */
function gitInGroup(args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, env: gitChildEnv(), detached: true });
    const pid = child.pid;
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const term = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) signalGroup(pid, "SIGTERM");
    }, timeoutMs);
    const kill = setTimeout(() => pid !== undefined && signalGroup(pid, "SIGKILL"), timeoutMs + TERM_GRACE_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(term);
      clearTimeout(kill);
      void (pid === undefined ? Promise.resolve() : reapGroup(pid)).then(() => {
        const settled = timedOut ? new AddTimedOut() : settleAdd(code, out, err);
        if (typeof settled === "string") resolve(settled);
        else reject(settled);
      });
    });
  });
}

/**
 * A timed-out add can leave a half-written directory and a registration under
 * `.git/worktrees`. Only a directory the add itself created is removed: one that
 * existed beforehand belongs to someone else. The branch a `-b` add created is
 * kept, since it holds no commits and the next attach resets it.
 */
async function discardHalfCreated(gitRoot: string, args: readonly string[], created: boolean): Promise<void> {
  const target = addTarget(args);
  if (created && target !== undefined) {
    await gitOrNull(["worktree", "remove", "--force", target], gitRoot, CLEANUP_TIMEOUT_MS);
    rmSync(target, { recursive: true, force: true });
  }
  await gitOrNull(["worktree", "prune"], gitRoot, CLEANUP_TIMEOUT_MS);
}

/** The newest add per path; a late finisher only cleans up if no later add has taken the path since. */
const latestAdd = new Map<string, object>();

/** One hung add (a hook, a filter) must not hold the repo's queue forever. */
export function boundedAdd(run: WorktreeAddRunner | undefined, timeoutMs: number): WorktreeAddRunner {
  return async (args, cwd) => {
    const target = addTarget(args);
    const created = target !== undefined && !existsSync(target);
    const mine = {};
    if (target !== undefined) latestAdd.set(target, mine);
    const timedOut = new Error(`git worktree add in ${cwd} timed out after ${timeoutMs}ms and was killed`);
    try {
      return await (run === undefined
        ? gitInGroup(args, cwd, timeoutMs)
        : raceTimer(run(args, cwd), timeoutMs, () => cleanLate(cwd, args, created, mine)));
    } catch (err) {
      if (!(err instanceof AddTimedOut)) throw err;
      await discardHalfCreated(cwd, args, created);
      throw timedOut;
    }
  };
}

async function cleanLate(cwd: string, args: readonly string[], created: boolean, mine: object): Promise<void> {
  const target = addTarget(args);
  if (target === undefined || latestAdd.get(target) !== mine) return;
  await discardHalfCreated(cwd, args, created);
}

async function raceTimer(add: Promise<string>, timeoutMs: number, onLate: () => Promise<void>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AddTimedOut()), timeoutMs);
  });
  try {
    return await Promise.race([add, expired]);
  } catch (err) {
    if (err instanceof AddTimedOut) void add.then(onLate, () => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
