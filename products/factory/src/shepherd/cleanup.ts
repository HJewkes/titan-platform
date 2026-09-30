import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { deadline, type Deadline } from "../workflows/deadline.js";
import type { Registration, ShepherdStoreRef } from "./store.js";

/** The CC-188 grace clock: a retire waits this long past the agent's exit, so its last writes settle. */
export const SH_CLEANUP_GRACE_MS = 3 * 60_000;
export const SH_CLEANUP_RETRY_MS = 10 * 60_000;
export const SH_CLEANUP_GIVE_UP_MS = 60 * 60_000;
export const SH_CLEANUP_POLL_MS = 30_000;

export interface CleanupAgent {
  name: string;
  /** `live`, `detached` or `exited`, as agent-chat's roster reports it. */
  presence: string;
  status: string;
}

export interface CleanupAgents {
  roster(): Promise<readonly CleanupAgent[]>;
  /** Never forced: a forced retire discards work the agent's worktree still holds. */
  retire(name: string): Promise<void>;
}

export type TaskState = "open" | "done" | "missing";

export interface CleanupTasks {
  state(initiative: string, id: string): Promise<TaskState>;
  done(initiative: string, id: string): Promise<void>;
}

export interface CleanupPorts {
  agents: CleanupAgents;
  tasks: CleanupTasks;
}

export interface CleanupDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  cleanup?: CleanupPorts;
}

export interface CleanupInput {
  repo: RepoSlug;
  pr: number;
  runId: string;
}

export const CleanupResult = z.looseObject({
  ref: z.string(),
  task: z.string(),
  retired: z.array(z.string()),
  caveats: z.array(z.string()),
});

export type Cleanup = z.infer<typeof CleanupResult>;

interface Waiter {
  clock: Deadline;
  pollMs: number;
  signal: AbortSignal;
  now: () => number;
  caveats: string[];
}

/** Safe to repeat: every part reads before it writes, and refusals end as caveats after an hour, never as a failed run. */
export async function runCleanup(deps: CleanupDeps, input: CleanupInput, signal: AbortSignal): Promise<Cleanup> {
  const clock = deadline({ now: deps.now, sleep: deps.sleep, timeoutMs: SH_CLEANUP_GIVE_UP_MS });
  const wait: Waiter = { clock, pollMs: deps.pollMs ?? SH_CLEANUP_POLL_MS, signal, now: deps.now, caveats: [] };
  const ref = (await retrying(`head ref of #${input.pr}`, () => deleteHead(deps.port, input), wait)) ?? "unread";
  const registration = deps.store.get().byRun(input.runId);
  if (registration === undefined || deps.cleanup === undefined) {
    const why = registration === undefined ? "no registration" : "no cleanup ports wired";
    return { ref, task: why, retired: [], caveats: wait.caveats };
  }
  const task = await closeTask(deps.cleanup.tasks, registration.task, wait);
  const retired = await retireAll(deps.cleanup.agents, deps.store.get(), registration, input, wait);
  return { ref, task, retired, caveats: wait.caveats };
}

/** The ref lives in the head repo, so a fork's same-named branch in the base repo is never touched; the port skips forks and the default branch. */
async function deleteHead(port: GitHubPort, input: CleanupInput): Promise<string> {
  const pr = await port.getPr(input.repo, input.pr);
  if (!pr.merged) return "not-merged";
  const result = await port.deleteRef(input.repo, { branch: pr.headRef, repo: pr.headRepo });
  return result.done ? "deleted" : result.skipped;
}

async function closeTask(tasks: CleanupTasks, key: string, wait: Waiter): Promise<string> {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    wait.caveats.push(`task ${key} is not <initiative>/<id>`);
    return "unparsed";
  }
  const [initiative, id] = [key.slice(0, slash), key.slice(slash + 1)];
  const close = async (): Promise<string> => {
    const state = await tasks.state(initiative, id);
    if (state !== "open") return state === "done" ? "already-done" : "missing";
    await tasks.done(initiative, id);
    return "done";
  };
  return (await retrying(`task ${key}`, close, wait)) ?? "unread";
}

async function retrying<T>(what: string, attempt: () => Promise<T>, wait: Waiter): Promise<T | undefined> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (wait.clock.expired()) {
        wait.caveats.push(`${what}: ${message(error)}`);
        return undefined;
      }
      await wait.clock.sleep(wait.pollMs, wait.signal);
    }
  }
}

/** Newest successor first, then the implementer, then this PR's fresh reviewers; the standing reviewer is never among them. */
export function retireOrder(registration: Registration, lineageSuccessors: readonly string[], roster: readonly CleanupAgent[], input: CleanupInput): string[] {
  const successorName = new RegExp(`^${escapeRegExp(registration.implementer)}-s(\\d+)$`);
  const numbered = roster.flatMap((agent) => {
    const k = successorName.exec(agent.name)?.[1];
    return k === undefined ? [] : [{ name: agent.name, k: Number(k) }];
  });
  const successors = [...[...lineageSuccessors].reverse(), ...numbered.sort((a, b) => b.k - a.k).map((agent) => agent.name)];
  const reviewerName = new RegExp(`^${escapeRegExp(freshReviewerBase(input.repo, input.pr))}(-\\d+)?$`);
  const reviewers = roster.map((agent) => agent.name).filter((name) => reviewerName.test(name));
  const standing = registration.policy.reviewer;
  return [...new Set([...successors, registration.implementer, ...reviewers])].filter((name) => name !== standing);
}

/** The name `sh-review` gives the first fresh reviewer of a PR; later ones append `-<k>`. */
export function freshReviewerBase(repo: RepoSlug, pr: number): string {
  const repoName = (repo.split("/")[1] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `rv-${repoName.slice(0, 32) || "repo"}-${pr}`;
}

async function retireAll(agents: CleanupAgents, store: ReturnType<ShepherdStoreRef["get"]>, registration: Registration, input: CleanupInput, wait: Waiter): Promise<string[]> {
  const lineage = store.authorsOf(registration.runId).filter((author) => author.role === "successor").map((author) => author.name);
  const roster = (await retrying("agent roster", () => agents.roster(), wait)) ?? [];
  const retired: string[] = [];
  for (const name of retireOrder(registration, lineage, roster, input)) {
    const caveat = await retireWhenSettled(agents, name, wait);
    if (caveat === undefined) retired.push(name);
    else wait.caveats.push(caveat);
  }
  return retired;
}

/** Exit time is when this step first saw the agent exited, which is never earlier than the real exit, so the grace holds. */
async function retireWhenSettled(agents: CleanupAgents, name: string, wait: Waiter): Promise<string | undefined> {
  let exitedAt: number | undefined;
  let nextTry = 0;
  let last = "not seen exited";
  for (;;) {
    const row = await rosterRow(agents, name).catch((error: unknown) => (last = message(error), "unread" as const));
    if (row === undefined || (row !== "unread" && row.status === "retired")) return undefined;
    if (row !== "unread") exitedAt = row.presence === "exited" ? (exitedAt ?? wait.now()) : undefined;
    if (exitedAt !== undefined && wait.now() >= Math.max(exitedAt + SH_CLEANUP_GRACE_MS, nextTry)) {
      const refused = await agents.retire(name).then(() => undefined, (error: unknown) => error);
      if (refused === undefined || alreadyGone(refused)) return undefined;
      last = message(refused);
      nextTry = wait.now() + SH_CLEANUP_RETRY_MS;
    }
    if (wait.clock.expired()) return `retire ${name}: ${last}`;
    await wait.clock.sleep(wait.pollMs, wait.signal);
  }
}

async function rosterRow(agents: CleanupAgents, name: string): Promise<CleanupAgent | undefined> {
  return (await agents.roster()).find((agent) => agent.name === name);
}

const alreadyGone = (error: unknown): boolean => /no agent named|already retired/i.test(message(error));

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
