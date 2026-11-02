import { isAbsolute } from "node:path";
import { DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { awaitNewHeadRoute } from "../workflows/await-head.js";
import { codeRoute } from "../workflows/land.js";
import { FIXER_EXIT_STEPS, fixerExitRoutes } from "./flake-check.js";
import { FIX_PROOF_WAKE_STEP } from "./fix-proof-cap.js";
import { successorConfigDir, successorSpawnAccounts } from "./account-hold.js";
import { noteFixerLimit } from "./fixer-limit.js";
import { agentChatAgents, type AgentChatAgents, type SpawnAccounts } from "./agents.js";
import type { ShepherdDeps } from "./phases.js";
import { failureOf } from "./error-class.js";
import { headMoved, unreadableHead, type HeadRead } from "./head-read.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { seatCheckout } from "./seat-checkout.js";
import type { Registration } from "./store.js";
import { FIX_FIRST_STEP, HEAD_LINE, REPAIR_STEP, describeWake, isRefName, successorBrief, wantsFreshFixer, withMergeBaseException } from "./wake-brief.js";
import { exitedOn, latestRow, lineageSeat, newestAgent, successorName } from "./wake-roster.js";
import { HOLDING_KINDS } from "./held-wake.js";
import { messagePredecessor, noticeSpawner, type PredecessorMessage, type SpawnerNotice } from "./wake-notice.js";
import { retireHung, type Hung } from "./wake-hung.js";
import { TURN_START_MS, awaitTurn, transcriptTurnSince, type TurnSince } from "./turn-check.js";
import { deadlineFor, expiredWait, rosterWhileBrokerDown, waitAPoll, waitOf, whileDeferred, type Wait, type WaitDeadlines, type Waiting } from "./wake-wait.js";
import { DEFAULT_WARMTH_LIMITS, isWarm, readWarmth, type Warmth, type WarmthLimits } from "./warmth.js";

export const WAKE_STEP = "sh-wake-implementer";
export const AWAIT_NEW_HEAD_STEP = "sh-await-new-head";
export const WAKE_STEPS: readonly StepDeclaration[] = [
  { id: WAKE_STEP, kind: "dispatch" },
  { id: AWAIT_NEW_HEAD_STEP, kind: "dispatch" },
  { id: FIX_FIRST_STEP, kind: "dispatch" },
  { id: REPAIR_STEP, kind: "dispatch" },
  { id: FIX_PROOF_WAKE_STEP, kind: "dispatch" },
  ...FIXER_EXIT_STEPS,
];

/** The agent-chat profile Shepherd's fixers and successors start under; the profile is their tool grant. It is headless because no one watches a pane for them, and the builtin `implementer` opens one. */
export const FACTORY_IMPLEMENTER_PROFILE = "bd-implementer";
const DEFAULT_POLL_MS = 30_000;

/** How the wake step reaches agent-chat. A broker that is down or a timeout is waited out; any other throw is a refusal. */
export interface ImplementerAgents {
  roster(): Promise<readonly AgentRow[]>;
  resume(name: string, message: string): Promise<void>;
  /** Delivers `message` to a live agent as one chat message, sent as the human until CC-436 adds a `shepherd` wake source. */
  message(name: string, message: string): Promise<void>;
  /** `cwd` is a checkout of the PR's repo, which the successor's own worktree is cut from. */
  spawn(name: string, brief: string, cwd: string): Promise<void>;
  /** Never forced; absent means a live agent that takes no wake is left to its seat. */
  retire?(name: string): Promise<void>;
}

/** `accounts` is read per spawn; absent leaves the adapter's own account with no fallback. */
export const implementersOver = (agents: AgentChatAgents, accounts: () => SpawnAccounts = () => ({})): ImplementerAgents => ({
  ...agents,
  spawn: (name, brief, cwd) => agents.spawn({ name, profile: FACTORY_IMPLEMENTER_PROFILE, brief, cwd, ...accounts() }),
});

export interface WakeWiring extends WaitDeadlines {
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
/**
 * The step's record: who took the wake and how, and the second ask that started its turn, for the wake analytics. A
 * `held` wake is one whose successor agent-chat refused to start, so its seat can be told before the owner is asked.
 */
export type WakeStepResult =
  | { kind: "woken"; agent: string; mode: Mode; sessionId?: string; fallback?: Fallback; askedAt?: number }
  | { kind: "unhandled"; reason: string; held?: { agent: string }; notice?: SpawnerNotice; predecessor?: PredecessorMessage };

const unhandled = (reason: string): WakeStepResult => ({ kind: "unhandled", reason });
const held = (agent: string, error: unknown): WakeStepResult => ({ kind: "unhandled", reason: `agent-chat refused to start the successor ${agent}: ${failureOf(error)}`, held: { agent } });


interface WakeTask {
  input: WakeInput;
  pr: PullRequest;
  reason: string;
  payload: string;
  implementer: string;
  /** Successors the store's lineage records, earliest first. */
  successors: readonly string[];
}

function resumeMessage(task: WakeTask): string {
  const { input, pr } = task;
  const intro = `Shepherd is waking you on ${input.repo}#${input.pr}. ${task.reason}`;
  return `${intro}\n\n${task.payload}\n\nFix it on branch \`${pr.headRef}\`, push, and ${HEAD_LINE}`;
}

type Choice =
  | { mode: "resume" | "live"; agent: string; message: string; sessionId: string }
  | { mode: "successor"; agent: string; predecessor: string; message: string; cwd: string };

/** A retired agent, one whose resume agent-chat refused this wake, or one a fresh-fixer wake passes over, is not asked again; a successor takes over. */
const resumable = (newest: AgentRow, refused: ReadonlySet<string>, input: WakeInput): boolean => newest.status !== "retired" && !refused.has(newest.name) && !wantsFreshFixer(input.payload);

/** A string is why nobody can be woken. */
async function choose(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, newest: AgentRow, roster: readonly AgentRow[], refused: ReadonlySet<string>): Promise<Choice | string> {
  const path = newest.transcriptExists === true && newest.sessionId !== "" && resumable(newest, refused, task.input) ? newest.transcriptPath : null;
  const warmth = typeof path === "string" ? await (wiring.readWarmth ?? readWarmth)(path) : undefined;
  if (isWarm(warmth, deps.now(), wiring.limits ?? DEFAULT_WARMTH_LIMITS)) {
    return { mode: "resume", agent: newest.name, message: resumeMessage(task), sessionId: newest.sessionId };
  }
  return successorChoice(deps, wiring, task, newest.name, roster);
}

function successorChoice(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, predecessor: string, roster: readonly AgentRow[]): Choice | string {
  if (deps.advisory?.(task.input.repo)) return `${task.input.repo} is advisory, so Shepherd starts no successor to push to it`;
  const checkout = resolveCheckout(task.input.repo, (wiring.checkoutFor ?? seatCheckout())(task.input.repo), wiring.home);
  if ("problem" in checkout) return `${checkout.problem}, so a successor has no checkout to start in`;
  const agent = successorName(task, roster);
  return { mode: "successor", agent, predecessor, message: successorBrief(task, predecessor, agent, lineageSeat(task, roster)), cwd: checkout.dir };
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
 * The wait when the broker was down, the ask timed out or the spawn gate deferred it; any other failure is a refusal
 * and throws. A refusal of a re-ask is agent-chat refusing a duplicate once the earlier ask landed, so the roster decides.
 */
async function ask(deps: ShepherdDeps, agents: ImplementerAgents, choice: Choice, reask: boolean, signal: AbortSignal): Promise<true | Wait> {
  try {
    if (choice.mode === "successor") await agents.spawn(choice.agent, choice.message, choice.cwd);
    else await (choice.mode === "resume" ? agents.resume(choice.agent, choice.message) : agents.message(choice.agent, choice.message));
    return true;
  } catch (error) {
    const wait = waitOf(error);
    if (wait !== undefined) return wait;
    if (reask && tookEffect(choice, await rosterWhileBrokerDown(deps, agents, signal))) return true;
    throw error;
  }
}

/** What one ask came to: it was asked, it is waited out a poll, a successor is asked at once, or the step ends on a hold. */
type Sent = "asked" | Wait | "successor" | WakeStepResult;

/**
 * A resume agent-chat refuses, as of an agent on a model its pool no longer runs, is asked of a successor instead; a
 * refused successor is `held`, with the refusal named. Any other failure, and a refused message to a live agent, stays
 * a refusal: a successor beside a live agent would race it on the branch.
 */
async function askOrFallBack(deps: ShepherdDeps, agents: ImplementerAgents, choice: Choice, reask: boolean, refused: Set<string>, signal: AbortSignal): Promise<Sent> {
  try {
    const sent = await ask(deps, agents, choice, reask, signal);
    return sent === true ? "asked" : sent;
  } catch (error) {
    signal.throwIfAborted();
    if (choice.mode === "live" || !(error instanceof DispatchError)) throw error;
    if (choice.mode === "successor") return held(choice.agent, error);
    refused.add(choice.agent);
    return "successor";
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
 * ended by then, else a direct message. No turn after that leaves the wake unhandled, so the run does not wait on nobody,
 * unless a live agent ignored both asks and was retired, which `hung` reports so a successor is started.
 */
async function confirmTurn(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, asked: Asked, signal: AbortSignal): Promise<WakeStepResult | Hung> {
  await recordSuccessor(deps, agents, task, asked.choice, signal);
  const woke = { ...wokenBy(asked.choice), askedAt: asked.at };
  if (await awaitTurn(turnWatch(deps, wiring, agents, task, asked.choice.agent, signal), asked.at, signal)) return woke;
  const roster = await rosterWhileBrokerDown(deps, agents, signal);
  const fallback: Fallback = latestRow(asked.choice.agent, roster)?.presence === "exited" ? "resume" : "message";
  const at = deps.now();
  try {
    const again = () => (fallback === "resume" ? agents.resume(asked.choice.agent, resumeMessage(task)) : agents.message(asked.choice.agent, resumeMessage(task)));
    await whileDeferred(deps, deadlineFor(wiring, "deferred"), signal, again);
  } catch (error) {
    return unhandled(`${asked.choice.agent} started no turn after the wake, and the ${fallback} fallback failed: ${failureOf(error)}`);
  }
  if (await awaitTurn(turnWatch(deps, wiring, agents, task, asked.choice.agent, signal), at, signal)) return { ...woke, fallback, askedAt: at };
  const stalled = `${asked.choice.agent} started no turn within ${(wiring.turnStartMs ?? TURN_START_MS) / 60_000} minutes of the wake or of the ${fallback} fallback`;
  if (asked.choice.mode !== "live" || fallback !== "message") return unhandled(stalled);
  const replaceable = typeof successorChoice(deps, wiring, task, asked.choice.agent, await rosterWhileBrokerDown(deps, agents, signal)) !== "string";
  return retireHung(agents, asked.choice.agent, replaceable, stalled, signal);
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


const ASK_VERB: Record<Mode, string> = { resume: "resume", successor: "spawn", live: "message" };

/** An ask that never lands, as a resume of a parked tree that times out each time, fails the wake once the deadline passes. */
function askExpired(deps: ShepherdDeps, wiring: WakeWiring, asked: Asked | undefined, waiting: Waiting | undefined): WakeStepResult | undefined {
  if (asked === undefined || waiting === undefined) return undefined;
  const within = expiredWait(deps, deadlineFor(wiring, waiting.wait), waiting);
  return within === undefined ? undefined : unhandled(`${asked.choice.agent}'s ${ASK_VERB[asked.choice.mode]} took no effect within ${within}`);
}


async function prMovedOn(port: GitHubPort, input: WakeInput): Promise<boolean> {
  const pr = await port.getPr(input.repo, input.pr).catch(() => undefined);
  return pr !== undefined && (pr.headSha !== input.headSha || pr.state !== "open");
}

/**
 * A live agent that already pushed a new head took the wake itself, and is asked nothing; an unreadable PR defers the
 * ask a poll under its own deadline, so the ask deadline restarts after it. A lineage gone from the roster still has the
 * repo's checkout, so a successor takes over from the registered implementer (TP-4045), as it does from a live agent
 * retired for ignoring the wake and its fallback (TP-4430).
 */
async function wakeAgent(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, signal: AbortSignal): Promise<WakeStepResult> {
  const loop: WakeLoop = { refused: new Set<string>() };
  const unreadable = unreadableHead(deps, task.input, signal);
  for (;;) {
    const roster = await rosterWhileBrokerDown(deps, agents, signal);
    const { asked } = loop;
    const settled = settle(loop, asked && tookEffect(asked.choice, roster) ? await confirmTurn(deps, wiring, agents, task, asked, signal) : askExpired(deps, wiring, asked, loop.waiting));
    if (settled !== undefined) return settled;
    const newest = newestAgent(task, roster);
    const live = newest !== undefined && newest.presence !== "exited";
    const read: HeadRead = live ? await headMoved(deps.port, task.input) : { moved: false };
    if ("error" in read) {
      const gaveUp = await unreadable.failed(read.error);
      if (gaveUp !== undefined) return unhandled(gaveUp);
      loop.waiting = undefined;
      continue;
    }
    unreadable.read();
    if (read.moved && newest !== undefined) return wokenBy(liveChoice(task, newest));
    const choice = await nextChoice(deps, wiring, task, roster, newest, loop);
    if (typeof choice === "string") return unhandled(choice);
    const done = await askOnce(deps, wiring, agents, task, choice, loop, signal);
    if (done !== undefined) return done;
  }
}

interface WakeLoop {
  asked?: Asked;
  waiting?: Waiting;
  refused: Set<string>;
  /** The live agent retired for taking no wake; from then on only its successor is asked. */
  hung?: string;
}

/** A retired hung agent sends the loop round again to start its successor; anything else settles the wake. */
function settle(loop: WakeLoop, result: WakeStepResult | Hung | undefined): WakeStepResult | undefined {
  if (result?.kind !== "hung") return result;
  loop.hung = result.agent;
  loop.asked = loop.waiting = undefined;
  return undefined;
}

async function nextChoice(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, roster: readonly AgentRow[], newest: AgentRow | undefined, loop: WakeLoop): Promise<Choice | string> {
  if (loop.hung !== undefined) return successorChoice(deps, wiring, task, loop.hung, roster);
  if (newest === undefined) return successorChoice(deps, wiring, task, task.implementer, roster);
  return newest.presence !== "exited" ? liveChoice(task, newest) : choose(deps, wiring, task, newest, roster, loop.refused);
}

/** One ask and what follows it: a settled wake, or undefined to go round again after a wait, a fallback or a retire. */
async function askOnce(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, choice: Choice, loop: WakeLoop, signal: AbortSignal): Promise<WakeStepResult | undefined> {
  const reask = sameAsk(loop.asked?.choice, choice);
  const asked: Asked = { choice, at: deps.now() };
  loop.asked = asked;
  const sent = await askOrFallBack(deps, agents, choice, reask, loop.refused, signal);
  if (sent === "asked") return settle(loop, await confirmTurn(deps, wiring, agents, task, asked, signal));
  if (typeof sent === "object") return sent;
  if (sent !== "successor") loop.waiting = await waitAPoll(deps, { since: loop.waiting?.since ?? asked.at, wait: sent }, signal);
  return undefined;
}

async function wakeTask(deps: ShepherdDeps, input: WakeInput, registration: Registration): Promise<WakeTask | string> {
  const pr = await deps.port.getPr(input.repo, input.pr);
  if (pr.state !== "open") return `${input.repo}#${input.pr} is no longer open`;
  if (!isRefName(pr.headRef)) return `the head branch name of ${input.repo}#${input.pr} is not one a brief can carry`;
  if (!isRefName(pr.baseRef)) return `the base branch name of ${input.repo}#${input.pr} is not a valid ref name`;
  const successors = deps.store.get().authorsOf(input.runId).filter((author) => author.role === "successor").map((author) => author.name);
  return { input, pr, ...(await describeWake(deps.port, withMergeBaseException(input, deps.store), pr, deps.suiteRules?.fixer)), implementer: registration.implementer, successors };
}

function agentsFor(deps: ShepherdDeps, wiring: WakeWiring): ImplementerAgents | undefined {
  return wiring.agents ?? (isAbsolute(deps.agentChatBin) ? implementersOver(agentChatAgents(deps.agentChatBin, { configDir: successorConfigDir(deps), roster: deps.roster, gate: deps.spawnGate }), () => successorSpawnAccounts(deps)) : undefined);
}

/** Never throws but for an abort: a refusal or a failed read is `unhandled`, so the run falls back to the owner gate; a `held` one tells the seat first. */
async function wakeImplementer(deps: ShepherdDeps, wiring: WakeWiring, input: WakeInput, signal: AbortSignal): Promise<WakeStepResult> {
  const agents = agentsFor(deps, wiring);
  if (agents === undefined) return unhandled("shepherd.agentChatBin is not configured");
  try {
    const registration = deps.store.get().byRun(input.runId);
    if (registration === undefined) return unhandled(`run ${input.runId} has no shepherd registration`);
    if (!registration.policy.fixer) return unhandled("seat grants no fixer");
    const task = await wakeTask(deps, input, registration);
    if (typeof task === "string") return unhandled(task);
    const woke = await wakeAgent(deps, wiring, agents, task, signal).catch((error: unknown) => refusedWake(error, signal));
    return tellSpawner(deps, agents, task, await tellHeld(agents, task, heldOnlyIfHolding(input.kind, woke), signal), signal);
  } catch (error) {
    return refusedWake(error, signal);
  }
}

function refusedWake(error: unknown, signal: AbortSignal): WakeStepResult {
  signal.throwIfAborted();
  return unhandled(`the wake was refused: ${failureOf(error)}`);
}

/** A held wake's seat is told by its own route; the lineage's newest agent is messaged its findings now. */
async function tellHeld(agents: ImplementerAgents, task: WakeTask, result: WakeStepResult, signal: AbortSignal): Promise<WakeStepResult> {
  if (result.kind !== "unhandled" || result.held === undefined) return result;
  const predecessor = await messagePredecessor(agents, task, result.reason, signal);
  return { ...result, predecessor };
}

/** A held wake's seat is told by its own route. */
async function tellSpawner(deps: ShepherdDeps, agents: ImplementerAgents, task: WakeTask, result: WakeStepResult, signal: AbortSignal): Promise<WakeStepResult> {
  if (result.kind !== "unhandled" || result.held !== undefined || deps.exitNotice === undefined) return result;
  return { ...result, notice: await noticeSpawner(deps.exitNotice, () => agents.roster(), task, result.reason, signal) };
}

/** The step's record is what `wakePhase` and the view both read, so a kind that never holds records no `held`. */
function heldOnlyIfHolding(kind: WakeInput["kind"], result: WakeStepResult): WakeStepResult {
  return result.kind === "unhandled" && result.held !== undefined && !HOLDING_KINDS.has(kind) ? unhandled(result.reason) : result;
}

/** A malformed input fails the step; the await step reads and never writes, so each repeats safely after a crash. */
export const wakeRoutes = (deps: ShepherdDeps, wiring: WakeWiring = {}): readonly StepRoute[] => [
  codeRoute(WAKE_STEP, deps.now, async (raw: unknown, signal) => wakeImplementer(deps, wiring, WakeInputSchema.parse(raw), signal)),
  awaitNewHeadRoute({ ...deps, agentExited: exitedOn(agentsFor(deps, wiring), noteFixerLimit(deps)) }, AWAIT_NEW_HEAD_STEP),
  codeRoute(FIX_FIRST_STEP, deps.now, async (input: object) => input),
  codeRoute(REPAIR_STEP, deps.now, async (input: object) => input),
  codeRoute(FIX_PROOF_WAKE_STEP, deps.now, async (input: object) => input),
  ...fixerExitRoutes(deps.port, deps.now, deps.exitNotice),
];
