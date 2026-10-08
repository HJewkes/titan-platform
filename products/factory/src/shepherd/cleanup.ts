import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { deadline, type Deadline } from "../workflows/deadline.js";
import { failureOf } from "./error-class.js";
import type { Presence } from "./presence.js";
import type { Registration, ShepherdStoreRef } from "./store.js";

/** The CC-188 grace clock: a retire waits this long past the agent's exit, so its last writes settle. */
export const SH_CLEANUP_GRACE_MS = 3 * 60_000;
export const SH_CLEANUP_RETRY_MS = 10 * 60_000;
export const SH_CLEANUP_GIVE_UP_MS = 60 * 60_000;
export const SH_CLEANUP_POLL_MS = 30_000;

export interface CleanupAgent {
  name: string;
  presence: Presence;
  status: string;
}

export interface CleanupAgents {
  roster(): Promise<readonly CleanupAgent[]>;
  /** Drops any cached roster, so the next `roster()` reads the broker. */
  invalidate(): void;
  /** Never forced: a forced retire discards work the agent's worktree still holds. */
  retire(name: string): Promise<void>;
}

export type TaskState = "open" | "done" | "missing";

export interface CleanupTasks {
  state(initiative: string, id: string): Promise<TaskState>;
  done(initiative: string, id: string): Promise<void>;
  /** Adds a line to the task's notes unless the notes already hold it, so a repeated cleanup adds nothing. */
  appendNote(initiative: string, id: string, line: string): Promise<void>;
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

/** Safe to repeat: every part reads before it writes, and refusals end as caveats after an hour, never as a failed run. Each part has its own hour. */
export async function runCleanup(deps: CleanupDeps, input: CleanupInput, signal: AbortSignal): Promise<Cleanup> {
  const caveats: string[] = [];
  const waiter = (): Waiter => ({ clock: deadline({ now: deps.now, sleep: deps.sleep, timeoutMs: SH_CLEANUP_GIVE_UP_MS }), pollMs: deps.pollMs ?? SH_CLEANUP_POLL_MS, signal, now: deps.now, caveats });
  const ref = (await retrying(`head ref of #${input.pr}`, () => deleteHead(deps.port, input), waiter())) ?? "unread";
  await retrying(`hold on #${input.pr}`, () => releaseLanded(deps, input), waiter());
  const registration = deps.store.get().byRun(input.runId);
  if (registration === undefined || deps.cleanup === undefined) {
    const why = registration === undefined ? "no registration" : "no cleanup ports wired";
    return { ref, task: why, retired: [], caveats };
  }
  const task = await settleTask(deps, registration, input, waiter());
  const retired = await retireAll(deps.cleanup.agents, deps.store.get(), registration, input, waiter());
  return { ref, task, retired, caveats };
}

/** The ref lives in the head repo, so a fork's same-named branch in the base repo is never touched; the port skips forks and the default branch. */
async function deleteHead(port: GitHubPort, input: CleanupInput): Promise<string> {
  const pr = await port.getPr(input.repo, input.pr);
  if (!pr.merged) return "not-merged";
  const result = await port.deleteRef(input.repo, { branch: pr.headRef, repo: pr.headRepo });
  return result.done ? "deleted" : result.skipped;
}

/** A hold, satisfied or not, has nothing left to hold once the PR merged; an open PR keeps it. */
async function releaseLanded(deps: CleanupDeps, input: CleanupInput): Promise<void> {
  const store = deps.store.get();
  if (store.byRun(input.runId)?.held !== true) return;
  if ((await deps.port.getPr(input.repo, input.pr)).merged) store.release(input.runId);
}

/**
 * A slice PR notes its task and leaves it open, because the task's other slices have not landed. Any other PR cites itself
 * and its merge sha in the task's notes, then closes it. A slice with an unread merge sha writes nothing, so a retry cannot add a second
 * line for the landing; a close still goes ahead then, citing the PR alone, because an unreadable GitHub must not keep a
 * merged task open.
 */
async function settleTask(deps: CleanupDeps, registration: Registration, input: CleanupInput, wait: Waiter): Promise<string> {
  const tasks = deps.cleanup!.tasks;
  const pr = await retrying(`merge sha of #${input.pr}`, () => deps.port.getPr(input.repo, input.pr), wait);
  const landing = `${input.repo}#${input.pr} at ${pr?.mergeSha ?? "unknown"}`;
  if (registration.slice === null) return closeTask(tasks, registration.task, `closed by Shepherd: ${landing} merged`, wait);
  if (pr === undefined) return "unread";
  return onOpenTask(registration.task, wait, (initiative, id) => tasks.appendNote(initiative, id, `${registration.slice} landed in ${landing}`).then(() => "noted"), tasks);
}

/** The note goes first: a crash between the two leaves an open task with its citation, and the replay finds the line already there. */
async function closeTask(tasks: CleanupTasks, key: string, note: string, wait: Waiter): Promise<string> {
  const closed = (initiative: string, id: string): Promise<string> => tasks.appendNote(initiative, id, note).then(() => tasks.done(initiative, id)).then(() => "done");
  return onOpenTask(key, wait, closed, tasks);
}

async function onOpenTask(key: string, wait: Waiter, act: (initiative: string, id: string) => Promise<string>, tasks: CleanupTasks): Promise<string> {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    wait.caveats.push(`task ${key} is not <initiative>/<id>`);
    return "unparsed";
  }
  const [initiative, id] = [key.slice(0, slash), key.slice(slash + 1)];
  const close = async (): Promise<string> => {
    const state = await tasks.state(initiative, id);
    if (state !== "open") return state === "done" ? "already-done" : "missing";
    return act(initiative, id);
  };
  return (await retrying(`task ${key} not closed`, close, wait)) ?? "unread";
}

async function retrying<T>(what: string, attempt: () => Promise<T>, wait: Waiter): Promise<T | undefined> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (wait.clock.expired()) {
        wait.caveats.push(`${what}: ${failureOf(error)}`);
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
  const slug = (part: string | undefined): string => (part ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const [owner, name] = repo.split("/");
  return `rv-${slug(owner) || "owner"}-${slug(name) || "repo"}-${pr}`;
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
    const row = await rosterRow(agents, name).catch((error: unknown) => (last = failureOf(error), "unread" as const));
    if (row === undefined || (row !== "unread" && row.status === "retired")) return undefined;
    if (row !== "unread") exitedAt = row.presence === "exited" ? (exitedAt ?? wait.now()) : undefined;
    if (exitedAt !== undefined && wait.now() >= Math.max(exitedAt + SH_CLEANUP_GRACE_MS, nextTry)) {
      const held = await heldByFreshRoster(agents, name);
      if (held !== undefined) {
        last = held;
        exitedAt = undefined;
        continue;
      }
      const refused = await agents.retire(name).then(() => undefined, (error: unknown) => error);
      if (refused === undefined || alreadyGone(refused)) return undefined;
      last = retireRefusal(refused);
      nextTry = wait.now() + SH_CLEANUP_RETRY_MS;
    }
    if (wait.clock.expired()) return `retire ${name}: ${last}`;
    await wait.clock.sleep(wait.pollMs, wait.signal);
  }
}

/** The cached roster may predate a resume, so the final decision reads the broker afresh. Returns why the retire must wait; an unreadable roster blocks it too. */
async function heldByFreshRoster(agents: CleanupAgents, name: string): Promise<string | undefined> {
  agents.invalidate();
  let unreadable = "";
  const row = await rosterRow(agents, name).catch((error: unknown) => ((unreadable = `roster unreadable before retire: ${failureOf(error)}`), "unread" as const));
  if (row === "unread") return unreadable;
  return row !== undefined && row.presence !== "exited" && row.status !== "retired" ? "resumed before retire" : undefined;
}

async function rosterRow(agents: CleanupAgents, name: string): Promise<CleanupAgent | undefined> {
  return (await agents.roster()).find((agent) => agent.name === name);
}

/** Reads the refusal text only to recognise an agent that is already gone; none of it is stored. */
const alreadyGone = (error: unknown): boolean => /no agent named|already retired/i.test(error instanceof Error ? error.message : String(error));

/** Fixed words for the refusals an owner triages by, since the refusal's own text names paths. */
const KNOWN_REFUSALS: readonly (readonly [RegExp, string])[] = [
  [/unpushed/i, "the worktree has unpushed commits"],
  [/uncommitted|untracked/i, "the worktree has uncommitted changes"],
];

function retireRefusal(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return KNOWN_REFUSALS.find(([pattern]) => pattern.test(text))?.[1] ?? failureOf(error);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
