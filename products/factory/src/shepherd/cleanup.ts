import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import { OVERLAY_SHAPES } from "@titan-design/review-panel";
import { z } from "zod";
import { hasSlicesBlock, readSlices } from "../dispatch/report.js";
import { deadline, type Deadline } from "../workflows/deadline.js";
import { consoleTextOf, errorClass, failureOf } from "./error-class.js";
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

/** What tells an unsliced PR whether it may close its task: the task's tags and notes, and its plan's text when it has one. */
export interface TaskSlicing {
  tags: readonly string[];
  notes: string;
  plan: string | undefined;
}

export interface CleanupTasks {
  state(initiative: string, id: string): Promise<TaskState>;
  slicing(initiative: string, id: string): Promise<TaskSlicing>;
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
  /** An advisory repo's head ref is never deleted, even after a human merge. */
  advisory?: (repo: RepoSlug) => boolean;
}

/** What the run's own merge step knew of the PR it merged; with it, cleanup reads no PR. */
export interface MergedPr {
  baseRef: string;
  headRef: string;
  headRepo: RepoSlug | null;
  headSha: string;
  mergeSha: string;
}

export interface CleanupInput {
  repo: RepoSlug;
  pr: number;
  runId: string;
  /** Absent for a PR merged outside the run, or a step recorded before the field: each part then reads the PR. */
  merged?: MergedPr;
}

type PrAfterMerge = Pick<PullRequest, "merged" | "baseRef" | "headRef" | "headRepo" | "headSha" | "mergeSha">;

async function prAfterMerge(port: GitHubPort, input: CleanupInput): Promise<PrAfterMerge> {
  return input.merged === undefined ? port.getPr(input.repo, input.pr) : { merged: true, ...input.merged };
}

const Retargeted = z.object({ pr: z.number(), ok: z.boolean(), error: z.string().optional() });
type Retargeted = z.infer<typeof Retargeted>;

export const CleanupResult = z.looseObject({
  ref: z.string(),
  /** The open PRs based on the merged head branch that cleanup moved onto its base before the delete; absent in a step recorded before the field. */
  retargeted: z.array(Retargeted).optional(),
  task: z.string(),
  retired: z.array(z.string()),
  caveats: z.array(z.string()),
});

export type Cleanup = z.infer<typeof CleanupResult>;

/** What the head-ref part did, kept across its retries: a retarget is recorded once per child, the last attempt winning. */
interface Done {
  caveats: string[];
  retargeted: Map<number, Retargeted>;
}

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
  const done: Done = { caveats, retargeted: new Map() };
  const ref = (await retrying(`head ref of #${input.pr}`, () => deleteHead(deps, input, done), waiter())) ?? "unread";
  const retargeted = [...done.retargeted.values()];
  await retrying(`hold on #${input.pr}`, () => releaseLanded(deps, input), waiter());
  const registration = deps.store.get().byRun(input.runId);
  if (registration === undefined || deps.cleanup === undefined) {
    const why = registration === undefined ? "no registration" : "no cleanup ports wired";
    return { ref, retargeted, task: why, retired: [], caveats };
  }
  const task = await settleTask(deps, registration, input, waiter());
  const retired = await retireAll(deps.cleanup.agents, deps.store.get(), registration, input, waiter());
  return { ref, retargeted, task, retired, caveats };
}

/**
 * The ref lives in the head repo, so a fork's same-named branch in the base repo is never touched; the port skips forks
 * and the default branch. An API delete closes every open PR based on the branch, and only GitHub's own delete-on-merge
 * retargets them first, so each is retargeted onto the merged PR's base here. A fresh list, read just before the delete,
 * keeps the branch while any PR is still based on it.
 */
async function deleteHead({ port, advisory }: CleanupDeps, input: CleanupInput, done: Done): Promise<string> {
  if (advisory?.(input.repo)) return "advisory";
  const pr = await prAfterMerge(port, input);
  if (!pr.merged) return "not-merged";
  if (pr.headRepo?.toLowerCase() === input.repo.toLowerCase() && pr.headRef !== (await port.defaultBranch(input.repo))) {
    for (const child of await basedOn(port, input.repo, pr.headRef)) done.retargeted.set(child, await retarget(port, input.repo, child, pr.baseRef));
    const based = await basedOn(port, input.repo, pr.headRef);
    if (based.length > 0) {
      done.caveats.push(`head ref of #${input.pr} kept: open ${based.map((child) => `#${child}`).join(", ")} still based on it`);
      return "children-open";
    }
  }
  const result = await port.deleteRef(input.repo, { branch: pr.headRef, repo: pr.headRepo });
  return result.done ? "deleted" : result.skipped;
}

const basedOn = async (port: GitHubPort, repo: RepoSlug, branch: string): Promise<number[]> => (await port.listOpenPrs(repo)).filter((open) => open.baseRef === branch).map((open) => open.number);

/** A failed retarget is recorded, never thrown, so the re-list keeps the branch; only the error class is stored, since the output can reach a public PR. */
async function retarget(port: GitHubPort, repo: RepoSlug, pr: number, base: string): Promise<Retargeted> {
  return port.setPrBase(repo, pr, base).then(
    (write) => (write.done || write.skipped === "unchanged" ? { pr, ok: true } : { pr, ok: false, error: write.skipped }),
    (error: unknown) => ({ pr, ok: false, error: errorClass(error) }),
  );
}

const CLEANUP_ACTOR = "shepherd:cleanup";

/** No Shepherd merge passes an owner-asked hold, so a PR that merged with one in force merged around it; its release event says so. */
const OWNER_HOLD_BYPASSED = "owner hold bypassed: merged outside Shepherd";

/** A hold, satisfied or not, has nothing left to hold once the PR merged; an open PR keeps it. The release event keeps who satisfied it, since the release clears that from the row. */
async function releaseLanded(deps: CleanupDeps, input: CleanupInput): Promise<void> {
  const store = deps.store.get();
  const registration = store.byRun(input.runId);
  if (registration?.held !== true) return;
  const pr = await prAfterMerge(deps.port, input);
  if (!pr.merged) return;
  const by = { actor: CLEANUP_ACTOR, headSha: pr.headSha };
  if (registration.ownerHold) store.releaseOwnerHold(input.runId, by, `${OWNER_HOLD_BYPASSED} (${registration.ownerHold.reason})`);
  if (store.byRun(input.runId)?.held) store.release(input.runId, by, satisfiedReason(store.byRun(input.runId)));
}

function satisfiedReason(registration: Registration | undefined): string | undefined {
  const holdSatisfied = registration?.holdSatisfied;
  if (!holdSatisfied) return undefined;
  const { head, by } = holdSatisfied;
  return `merged on ${by.reviewer}'s MERGE at ${head} (${by.agentId}/${by.sessionId})`;
}

/**
 * A slice PR notes its task and leaves it open, because the task's other slices have not landed. Any other PR cites itself
 * and its merge sha in the task's notes, then closes it, unless the task is sliced or an epic (CC-1150 closed on one
 * unregistered slice). A note with an unread merge sha is never written, so a retry cannot add a second line for the
 * landing; a close still goes ahead then, citing the PR alone, because an unreadable GitHub must not keep a merged task open.
 */
async function settleTask(deps: CleanupDeps, registration: Registration, input: CleanupInput, wait: Waiter): Promise<string> {
  const tasks = deps.cleanup!.tasks;
  const pr = await retrying(`merge sha of #${input.pr}`, () => prAfterMerge(deps.port, input), wait);
  const landing = `${input.repo}#${input.pr} at ${pr?.mergeSha ?? "unknown"}`;
  if (registration.slice === null) return onOpenTask(registration.task, wait, closeUnlessSliced(tasks, landing, pr !== undefined), tasks);
  if (pr === undefined) return "unread";
  return onOpenTask(registration.task, wait, (initiative, id) => tasks.appendNote(initiative, id, `${registration.slice} landed in ${landing}`).then(() => "noted"), tasks);
}

/** The note goes first: a crash between the two leaves an open task with its citation, and the replay finds the line already there. */
function closeUnlessSliced(tasks: CleanupTasks, landing: string, shaRead: boolean): (initiative: string, id: string) => Promise<string> {
  return async (initiative, id) => {
    const heldBy = heldOpenBy(await tasks.slicing(initiative, id));
    if (heldBy === undefined) {
      await tasks.appendNote(initiative, id, `closed by Shepherd: ${landing} merged`);
      await tasks.done(initiative, id);
      return "done";
    }
    if (!shaRead) return "unread";
    await tasks.appendNote(initiative, id, `PR ${landing} merged; task left open: ${heldBy}`);
    return "left-open";
  };
}

const EPIC_TAG = "epic";

/** Why one unsliced PR cannot close its task, or undefined when nothing else is due to land on it. */
function heldOpenBy({ tags, notes, plan }: TaskSlicing): string | undefined {
  if (plan !== undefined && hasSlicesBlock(plan)) {
    const slices = readSlices(plan).slices;
    if (slices === undefined) return "its plan has a burndown-slices block that does not read";
    const landed = new Set(notes.split("\n").flatMap((line) => /^(\S+) landed in /.exec(line)?.[1] ?? []));
    const unlanded = slices.map((slice) => slice.n).filter((n) => !landed.has(n));
    return unlanded.length === 0 ? "it is sliced, and every slice is noted landed" : `it has slices ${unlanded.join(", ")}`;
  }
  return tags.includes(EPIC_TAG) ? `it is tagged ${EPIC_TAG}` : undefined;
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


/** Newest successor first, then the implementer, then this PR's fresh reviewers and their panel members; the standing reviewer is never among them. */
export function retireOrder(registration: Registration, lineageSuccessors: readonly string[], roster: readonly CleanupAgent[], input: CleanupInput): string[] {
  const successorName = new RegExp(`^${escapeRegExp(registration.implementer)}-s(\\d+)$`);
  const numbered = roster.flatMap((agent) => {
    const k = successorName.exec(agent.name)?.[1];
    return k === undefined ? [] : [{ name: agent.name, k: Number(k) }];
  });
  const successors = [...[...lineageSuccessors].reverse(), ...numbered.sort((a, b) => b.k - a.k).map((agent) => agent.name)];
  const reviewers = roster.map((agent) => agent.name).filter(isOwnReviewer(input.repo, input.pr));
  const standing = registration.policy.reviewer;
  return [...new Set([...successors, registration.implementer, ...reviewers])].filter((name) => name !== standing);
}

const MEMBER_SUFFIX = `(?:-(?:${OVERLAY_SHAPES.join("|")})(?:-\\d+)?)?`;

/**
 * Shepherd's own reviewers of one PR: its fresh reviewers, and the panel members named after one of them or after the PR's
 * base. Park and cleanup both find them by this one test, so a new name form cannot reach only one of them.
 */
export function isOwnReviewer(repo: RepoSlug, pr: number): (name: string) => boolean {
  const own = new RegExp(`^${escapeRegExp(freshReviewerBase(repo, pr))}(?:-\\d+)?${MEMBER_SUFFIX}$`);
  return (name) => own.test(name);
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
const alreadyGone = (error: unknown): boolean => /no agent named|already retired/i.test(consoleTextOf(error));

/** Fixed words for the refusals an owner triages by, since the refusal's own text names paths. */
const KNOWN_REFUSALS: readonly (readonly [RegExp, string])[] = [
  [/unpushed/i, "the worktree has unpushed commits"],
  [/uncommitted|untracked/i, "the worktree has uncommitted changes"],
];

function retireRefusal(error: unknown): string {
  const text = consoleTextOf(error);
  return KNOWN_REFUSALS.find(([pattern]) => pattern.test(text))?.[1] ?? failureOf(error);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
