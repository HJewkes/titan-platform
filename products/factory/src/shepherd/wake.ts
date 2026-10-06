import { isAbsolute } from "node:path";
import { BrokerUnavailableError, DispatchTimeoutError, type AgentRow } from "@titan-design/agent-dispatch";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { z } from "zod";
import { configPath, loadConfig } from "../config.js";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { AwaitHeadResult, awaitNewHeadRoute } from "../workflows/await-head.js";
import { codeRoute, step } from "../workflows/land.js";
import { agentChatAgents, type AgentChatAgents } from "./agents.js";
import type { ShepherdDeps, ShepherdPhases, WakeRequest } from "./phases.js";
import { failureOf } from "./error-class.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { loadSeatBook, lookupSeat } from "./seats.js";
import type { Registration } from "./store.js";
import { FIX_FIRST_STEP, REPAIR_STEP, describeWake } from "./wake-brief.js";
import { TURN_START_MS, awaitTurn, transcriptTurnSince, type TurnSince } from "./turn-check.js";
import { DEFAULT_WARMTH_LIMITS, isWarm, readWarmth, type Warmth, type WarmthLimits } from "./warmth.js";

export const WAKE_STEP = "sh-wake-implementer";
export const AWAIT_NEW_HEAD_STEP = "sh-await-new-head";
export const WAKE_STEPS: readonly StepDeclaration[] = [
  { id: WAKE_STEP, kind: "dispatch" },
  { id: AWAIT_NEW_HEAD_STEP, kind: "dispatch" },
  { id: FIX_FIRST_STEP, kind: "dispatch" },
  { id: REPAIR_STEP, kind: "dispatch" },
];

/** The agent-chat profile Shepherd's fixers and successors start under; the profile is their tool grant. It is headless because no one watches a pane for them, and the builtin `implementer` opens one. */
export const FACTORY_IMPLEMENTER_PROFILE = "bd-implementer";
const DEFAULT_POLL_MS = 30_000;
/** A branch name that reaches a brief outside a fence, so it may hold nothing that could read as markup or a new line. */
const BRANCH = /^[A-Za-z0-9._/-]+$/;
/** The spellings git refuses in a ref name, among the characters `BRANCH` lets through. */
const BAD_REF = /^[-./]|\.\.|\/\/|\/\.|\.lock$|[/.]$/;
const isRefName = (name: string): boolean => BRANCH.test(name) && !BAD_REF.test(name);

/** How the wake step reaches agent-chat. A broker that is down or a timeout is waited out; any other throw is a refusal. */
export interface ImplementerAgents {
  roster(): Promise<readonly AgentRow[]>;
  resume(name: string, message: string): Promise<void>;
  /** Delivers `message` to a live agent as one chat message, sent as the human until CC-436 adds a `shepherd` wake source. */
  message(name: string, message: string): Promise<void>;
  /** `cwd` is a checkout of the PR's repo, which the successor's own worktree is cut from. */
  spawn(name: string, brief: string, cwd: string): Promise<void>;
}

export const implementersOver = (agents: AgentChatAgents): ImplementerAgents => ({
  ...agents,
  spawn: (name, brief, cwd) => agents.spawn({ name, profile: FACTORY_IMPLEMENTER_PROFILE, brief, cwd }),
});

export interface WakeWiring {
  /** Absent means agent-chat at `deps.agentChatBin`; a relative bin means none is configured, and every wake is unhandled. */
  agents?: ImplementerAgents;
  readWarmth?: (transcriptPath: string) => Promise<Warmth | undefined>;
  limits?: WarmthLimits;
  /** Defaults to reading the woken agent's transcript tail through `readWarmth`. */
  turnSince?: TurnSince;
  turnStartMs?: number;
  /** The repo's main checkout as configured, which a successor's worktree is cut from; undefined when none is bound. Defaults to the repo's seat path. */
  checkoutFor?: (repo: string) => string | undefined;
  /** The home a `~/`, `$HOME/` or `${HOME}/` checkout path expands against; defaults to the OS home. */
  home?: string;
}

/** The checkout a seat binds to `repo`, re-read per wake as the reviewer's spawn re-reads it. */
export function seatCheckout(env: NodeJS.ProcessEnv = process.env): (repo: string) => string | undefined {
  return (repo) => {
    const found = lookupSeat(loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}), repo);
    return found.kind === "seat" ? found.seat.paths[repo.toLowerCase()] : undefined;
  };
}

const WakeInputSchema = z.object({
  kind: z.enum(["ci-red", "review", "conflict", "fix-proof"]),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  headSha: z.string().min(1),
  payload: z.unknown(),
  runId: z.string().min(1),
  fixFirst: z.number().int().positive().optional(),
});

export type WakeInput = z.infer<typeof WakeInputSchema>;
type Mode = "resume" | "successor" | "live";
type Fallback = "resume" | "message";
/** The step's record: who took the wake and how, and the second ask that started its turn, for the wake analytics. */
export type WakeStepResult = { kind: "woken"; agent: string; mode: Mode; sessionId?: string; fallback?: Fallback } | { kind: "unhandled"; reason: string };

const unhandled = (reason: string): WakeStepResult => ({ kind: "unhandled", reason });

/** Waited out with no deadline: nothing was asked of the broker, or what was asked is checked on the next roster read. */
const brokerDown = (error: unknown): boolean => error instanceof BrokerUnavailableError || error instanceof DispatchTimeoutError;

interface WakeTask {
  input: WakeInput;
  pr: PullRequest;
  reason: string;
  payload: string;
  implementer: string;
  /** Successors the store's lineage records, earliest first. */
  successors: readonly string[];
}

const HEAD_LINE = "end with a line `Head: <full sha>` naming the head you pushed.";

function resumeMessage(task: WakeTask): string {
  const { input, pr } = task;
  const intro = `Shepherd is waking you on ${input.repo}#${input.pr}. ${task.reason}`;
  return `${intro}\n\n${task.payload}\n\nFix it on branch \`${pr.headRef}\`, push, and ${HEAD_LINE}`;
}

function successorBrief(task: WakeTask, predecessor: string, name: string): string {
  const { input, pr } = task;
  return [
    `You are ${name}, taking over ${input.repo}#${input.pr} from ${predecessor}, whose session has ended. ${task.reason}`,
    `Your worktree is cut from the repo's main checkout, not from the PR. Before editing, fetch the PR's head branch \`${pr.headRef}\` and check it out at the PR head ${pr.headSha}. Commit on top of it and push to it. Do not open a new PR.`,
    task.payload,
    `When pushed, register with Shepherd as this PR's implementer (\`titan-factory shepherd register\`), then ${HEAD_LINE}`,
  ].join("\n\n");
}

function successorIndex(implementer: string, name: string): number | undefined {
  const rest = name.startsWith(`${implementer}-s`) ? name.slice(implementer.length + 2) : "";
  return /^[1-9]\d*$/.test(rest) ? Number(rest) : undefined;
}

/** The implementer, then its successors: the lineage's first, then `<implementer>-s<k>` names by `k`. */
function chain(task: WakeTask, roster: readonly AgentRow[]): string[] {
  const indexed = roster.flatMap((row) => {
    const k = successorIndex(task.implementer, row.name);
    return k === undefined ? [] : [{ name: row.name, k }];
  });
  return [...new Set([task.implementer, ...task.successors, ...indexed.sort((a, b) => a.k - b.k).map((row) => row.name)])];
}

/** A name can span several sessions; the latest generation is the one that holds it. */
function latestRow(name: string, roster: readonly AgentRow[]): AgentRow | undefined {
  return roster.filter((row) => row.name === name).reduce<AgentRow | undefined>((best, row) => (best === undefined || row.generation >= best.generation ? row : best), undefined);
}

function newestAgent(task: WakeTask, roster: readonly AgentRow[]): AgentRow | undefined {
  return chain(task, roster)
    .reverse()
    .map((name) => latestRow(name, roster))
    .find((row) => row !== undefined);
}

function successorName(task: WakeTask, roster: readonly AgentRow[]): string {
  const taken = [...roster.map((row) => row.name), ...task.successors];
  const highest = Math.max(0, ...taken.map((name) => successorIndex(task.implementer, name) ?? 0));
  return `${task.implementer}-s${highest + 1}`;
}

type Choice =
  | { mode: "resume" | "live"; agent: string; message: string; sessionId: string }
  | { mode: "successor"; agent: string; predecessor: string; message: string; cwd: string };

/** A string is why nobody can be woken. */
async function choose(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, newest: AgentRow, roster: readonly AgentRow[]): Promise<Choice | string> {
  const path = newest.transcriptExists === true && newest.sessionId !== "" ? newest.transcriptPath : null;
  const warmth = typeof path === "string" ? await (wiring.readWarmth ?? readWarmth)(path) : undefined;
  if (isWarm(warmth, deps.now(), wiring.limits ?? DEFAULT_WARMTH_LIMITS)) {
    return { mode: "resume", agent: newest.name, message: resumeMessage(task), sessionId: newest.sessionId };
  }
  const checkout = resolveCheckout(task.input.repo, (wiring.checkoutFor ?? seatCheckout())(task.input.repo), wiring.home);
  if ("problem" in checkout) return `${checkout.problem}, so a successor has no checkout to start in`;
  const agent = successorName(task, roster);
  return { mode: "successor", agent, predecessor: newest.name, message: successorBrief(task, newest.name, agent), cwd: checkout.dir };
}

/** After a timeout the ask may have landed: a successor's name is on the roster, or the resumed agent is live again. A message leaves no mark. */
function tookEffect(choice: Choice, roster: readonly AgentRow[]): boolean {
  const row = latestRow(choice.agent, roster);
  if (choice.mode === "live") return false;
  return choice.mode === "successor" ? row !== undefined : row !== undefined && row.presence !== "exited";
}

function wokenBy(choice: Choice): Extract<WakeStepResult, { kind: "woken" }> {
  return { kind: "woken", agent: choice.agent, mode: choice.mode, ...(choice.mode !== "successor" && choice.sessionId !== "" && { sessionId: choice.sessionId }) };
}

/** A live agent is never resumed, because a second process would write its transcript; it is messaged instead. */
const liveChoice = (task: WakeTask, live: AgentRow): Choice => ({ mode: "live", agent: live.name, message: resumeMessage(task), sessionId: live.sessionId });

const sameAsk = (a: Choice | undefined, b: Choice): boolean => a !== undefined && a.mode === b.mode && a.agent === b.agent;

/**
 * False when the broker was down or the ask timed out; any other failure is a refusal and throws. A refusal of a
 * re-ask is agent-chat refusing a duplicate once the earlier ask landed, so the roster decides.
 */
async function ask(deps: ShepherdDeps, agents: ImplementerAgents, choice: Choice, reask: boolean, signal: AbortSignal): Promise<boolean> {
  try {
    if (choice.mode === "successor") await agents.spawn(choice.agent, choice.message, choice.cwd);
    else await (choice.mode === "resume" ? agents.resume(choice.agent, choice.message) : agents.message(choice.agent, choice.message));
    return true;
  } catch (error) {
    if (brokerDown(error)) return false;
    if (reask && tookEffect(choice, await rosterWhileBrokerDown(deps, agents, signal))) return true;
    throw error;
  }
}

/** A successor joins the run's lineage, so the next wake counts it; the broker's id is used once the roster shows it. */
async function recordSuccessor(deps: ShepherdDeps, agents: ImplementerAgents, task: WakeTask, choice: Choice, signal: AbortSignal): Promise<void> {
  if (choice.mode !== "successor") return;
  const row = latestRow(choice.agent, await rosterWhileBrokerDown(deps, agents, signal));
  deps.store.get().recordAuthor(task.input.runId, { agentId: row?.agentId ?? choice.agent, name: choice.agent, role: "successor", predecessor: choice.predecessor });
}

/**
 * The woken agent must start a turn within `turnStartMs`. If it does not, one fallback ask goes out: a resume if it has
 * ended by then, else a direct message. No turn after that leaves the wake unhandled, so the run does not wait on nobody.
 */
async function confirmTurn(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, asked: Asked, signal: AbortSignal): Promise<WakeStepResult> {
  await recordSuccessor(deps, agents, task, asked.choice, signal);
  const woke = wokenBy(asked.choice);
  if (await awaitTurn(turnWatch(deps, wiring, agents, task, asked.choice.agent, signal), asked.at, signal)) return woke;
  const roster = await rosterWhileBrokerDown(deps, agents, signal);
  const fallback: Fallback = latestRow(asked.choice.agent, roster)?.presence === "exited" ? "resume" : "message";
  const at = deps.now();
  try {
    await (fallback === "resume" ? agents.resume(asked.choice.agent, resumeMessage(task)) : agents.message(asked.choice.agent, resumeMessage(task)));
  } catch (error) {
    return unhandled(`${asked.choice.agent} started no turn after the wake, and the ${fallback} fallback failed: ${failureOf(error)}`);
  }
  if (await awaitTurn(turnWatch(deps, wiring, agents, task, asked.choice.agent, signal), at, signal)) return { ...woke, fallback };
  return unhandled(`${asked.choice.agent} started no turn within ${(wiring.turnStartMs ?? TURN_START_MS) / 60_000} minutes of the wake or of the ${fallback} fallback`);
}

function turnWatch(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, name: string, signal: AbortSignal) {
  return {
    now: deps.now,
    sleep: deps.sleep,
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    timeoutMs: wiring.turnStartMs ?? TURN_START_MS,
    row: async () => latestRow(name, await rosterWhileBrokerDown(deps, agents, signal)),
    prMovedOn: () => prMovedOn(deps.port, task.input),
    turnSince: wiring.turnSince ?? transcriptTurnSince(wiring.readWarmth ?? readWarmth),
  };
}

interface Asked {
  choice: Choice;
  /** Epoch milliseconds, so only a turn after the ask counts. */
  at: number;
}

async function rosterWhileBrokerDown(deps: ShepherdDeps, agents: ImplementerAgents, signal: AbortSignal): Promise<readonly AgentRow[]> {
  for (;;) {
    signal.throwIfAborted();
    try {
      return await agents.roster();
    } catch (error) {
      if (!brokerDown(error)) throw error;
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

/** `undefined` when the PR could not be read: neither moved nor not, so the caller decides on a later poll. */
async function headMoved(port: GitHubPort, input: WakeInput): Promise<boolean | undefined> {
  const pr = await port.getPr(input.repo, input.pr).catch(() => undefined);
  return pr === undefined ? undefined : pr.headSha !== input.headSha;
}

async function prMovedOn(port: GitHubPort, input: WakeInput): Promise<boolean> {
  const pr = await port.getPr(input.repo, input.pr).catch(() => undefined);
  return pr !== undefined && (pr.headSha !== input.headSha || pr.state !== "open");
}

/** A live agent that already pushed a new head took the wake itself, and is asked nothing; an unreadable PR defers the ask a poll. */
async function wakeAgent(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, signal: AbortSignal): Promise<WakeStepResult> {
  let asked: Asked | undefined;
  for (;;) {
    const roster = await rosterWhileBrokerDown(deps, agents, signal);
    if (asked && tookEffect(asked.choice, roster)) return confirmTurn(deps, wiring, agents, task, asked, signal);
    const newest = newestAgent(task, roster);
    if (newest === undefined) return unhandled(`no agent of ${task.implementer}'s lineage is on the roster, so no checkout is known to start a successor in`);
    const live = newest.presence !== "exited";
    const moved = live ? await headMoved(deps.port, task.input) : false;
    if (moved) return wokenBy(liveChoice(task, newest));
    if (moved === undefined) {
      await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
      continue;
    }
    const choice = live ? liveChoice(task, newest) : await choose(deps, wiring, task, newest, roster);
    if (typeof choice === "string") return unhandled(choice);
    const reask = sameAsk(asked?.choice, choice);
    asked = { choice, at: deps.now() };
    if (await ask(deps, agents, choice, reask, signal)) return confirmTurn(deps, wiring, agents, task, asked, signal);
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

async function wakeTask(deps: ShepherdDeps, input: WakeInput, registration: Registration): Promise<WakeTask | string> {
  const pr = await deps.port.getPr(input.repo, input.pr);
  if (pr.state !== "open") return `${input.repo}#${input.pr} is no longer open`;
  if (!isRefName(pr.headRef)) return `the head branch name of ${input.repo}#${input.pr} is not one a brief can carry`;
  if (!isRefName(pr.baseRef)) return `the base branch name of ${input.repo}#${input.pr} is not a valid ref name`;
  const successors = deps.store.get().authorsOf(input.runId).filter((author) => author.role === "successor").map((author) => author.name);
  return { input, pr, ...(await describeWake(deps.port, input, pr)), implementer: registration.implementer, successors };
}

/** Never throws but for an abort: a refusal or a failed read is `unhandled`, so the run falls back to the owner gate. */
async function wakeImplementer(deps: ShepherdDeps, wiring: WakeWiring, input: WakeInput, signal: AbortSignal): Promise<WakeStepResult> {
  const agents = wiring.agents ?? (isAbsolute(deps.agentChatBin) ? implementersOver(agentChatAgents(deps.agentChatBin, { configDir: deps.agentChatConfigDir, roster: deps.roster })) : undefined);
  if (agents === undefined) return unhandled("shepherd.agentChatBin is not configured");
  try {
    const registration = deps.store.get().byRun(input.runId);
    if (registration === undefined) return unhandled(`run ${input.runId} has no shepherd registration`);
    if (!registration.policy.fixer) return unhandled("seat grants no fixer");
    const task = await wakeTask(deps, input, registration);
    return typeof task === "string" ? unhandled(task) : await wakeAgent(deps, wiring, agents, task, signal);
  } catch (error) {
    signal.throwIfAborted();
    return unhandled(`the wake was refused: ${failureOf(error)}`);
  }
}

/** A malformed input fails the step; the await step reads and never writes, so each repeats safely after a crash. */
export const wakeRoutes = (deps: ShepherdDeps, wiring: WakeWiring = {}): readonly StepRoute[] => [
  codeRoute(WAKE_STEP, deps.now, async (raw: unknown, signal) => wakeImplementer(deps, wiring, WakeInputSchema.parse(raw), signal)),
  awaitNewHeadRoute(deps, AWAIT_NEW_HEAD_STEP),
  codeRoute(FIX_FIRST_STEP, deps.now, async (input: object) => input),
  codeRoute(REPAIR_STEP, deps.now, async (input: object) => input),
];

const Woke = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("woken"), agent: z.string(), sessionId: z.string().optional() }),
  z.looseObject({ kind: z.literal("unhandled"), reason: z.string() }),
]);

const FixFirstRecord = z.looseObject({ fixFirst: z.number().int().positive() });

/** Counts a review wake across every head of the run, so the second FIX_FIRST is known however many heads came between. */
async function countFixFirst(ctx: WorkflowContext, request: WakeRequest): Promise<number | undefined> {
  if (request.kind !== "review") return undefined;
  const record = { repo: request.repo, pr: request.pr, headSha: request.headSha, fixFirst: ctx.iteration(FIX_FIRST_STEP) + 1 };
  return (await step(ctx, FIX_FIRST_STEP, record, FixFirstRecord)).fixFirst;
}

/** Wakes an agent, then waits for the head to move; `woken` means a new head exists. A second wake in one round replays at the next index. */
export const wakePhase: ShepherdPhases["wake"] = async (ctx, request) => {
  const fixFirst = await countFixFirst(ctx, request);
  const woke = await step(ctx, `${WAKE_STEP}:${request.round}`, { ...request, runId: ctx.runId, ...(fixFirst !== undefined && { fixFirst }) }, Woke);
  if (woke.kind !== "woken") return { kind: "unhandled", reason: woke.reason };
  const target = { repo: request.repo, pr: request.pr, headSha: request.headSha };
  const head = await step(ctx, `${AWAIT_NEW_HEAD_STEP}:${request.round}`, target, AwaitHeadResult);
  if (head.headSha === request.headSha) return { kind: "unhandled", reason: `${request.repo}#${request.pr} closed at head ${request.headSha} before a new head` };
  return { kind: "woken", agent: woke.agent, ...(woke.sessionId !== undefined && { sessionId: woke.sessionId }) };
};
