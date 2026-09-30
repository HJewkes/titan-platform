import { isAbsolute } from "node:path";
import { BrokerUnavailableError, DispatchTimeoutError, dataFence, dispatchToAgentChat, listAgents, resumeAgent, type AgentRow } from "@titan-design/agent-dispatch";
import { isPassing, type CheckRun, type GitHubPort, type PullRequest, type RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import { AwaitHeadResult, awaitNewHeadRoute } from "../workflows/await-head.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps, ShepherdPhases, WakeRequest } from "./phases.js";
import type { Registration } from "./store.js";
import { DEFAULT_WARMTH_LIMITS, isWarm, readWarmth, type Warmth, type WarmthLimits } from "./warmth.js";

export const WAKE_STEP = "sh-wake-implementer";
export const AWAIT_NEW_HEAD_STEP = "sh-await-new-head";
export const WAKE_STEPS: readonly StepDeclaration[] = [
  { id: WAKE_STEP, kind: "dispatch" },
  { id: AWAIT_NEW_HEAD_STEP, kind: "dispatch" },
];

/** The agent-chat profile a successor starts under; the profile is its tool grant. */
export const SUCCESSOR_PROFILE = "implementer";
export const LOG_TAIL_LINES = 150;
/** The most CI log the wake carries across every failing job, headers included. */
export const LOG_BUDGET_BYTES = 8 * 1024;
export const LIVE_POLL_MS = 60_000;
export const CLI_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 30_000;
/** A branch name that reaches a brief outside a fence, so it may hold nothing that could read as markup or a new line. */
const BRANCH = /^[A-Za-z0-9._/-]+$/;

/** How the wake step reaches agent-chat. A broker that is down or a timeout is waited out; any other throw is a refusal. */
export interface ImplementerAgents {
  roster(): Promise<readonly AgentRow[]>;
  resume(name: string, message: string): Promise<void>;
  /** `cwd` is a checkout of the PR's repo, which the successor's own worktree is cut from. */
  spawn(name: string, brief: string, cwd: string): Promise<void>;
}

export function agentChatImplementers(agentChatBin: string, timeoutMs = CLI_TIMEOUT_MS): ImplementerAgents {
  return {
    roster: async () => listAgents(agentChatBin, timeoutMs),
    resume: async (name, message) => void resumeAgent(agentChatBin, name, message, timeoutMs),
    spawn: async (name, brief, cwd) =>
      void dispatchToAgentChat({ agentChatBinPath: agentChatBin, peerName: name, profile: SUCCESSOR_PROFILE, brief, cwd }, timeoutMs, [SUCCESSOR_PROFILE]),
  };
}

export interface WakeWiring {
  /** Absent means agent-chat at `deps.agentChatBin`; a relative bin means none is configured, and every wake is unhandled. */
  agents?: ImplementerAgents;
  readWarmth?: (transcriptPath: string) => Promise<Warmth | undefined>;
  limits?: WarmthLimits;
  livePollMs?: number;
}

const WakeInputSchema = z.object({
  kind: z.enum(["ci-red", "review", "conflict", "fix-proof"]),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  headSha: z.string().min(1),
  payload: z.unknown(),
  runId: z.string().min(1),
});

type WakeInput = z.infer<typeof WakeInputSchema>;
type Mode = "resume" | "successor" | "live";
/** The step's record: who took the wake and how, for the wake analytics. */
export type WakeStepResult = { kind: "woken"; agent: string; mode: Mode; sessionId?: string } | { kind: "unhandled"; reason: string };

const unhandled = (reason: string): WakeStepResult => ({ kind: "unhandled", reason });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Waited out with no deadline: nothing was asked of the broker, or what was asked is checked on the next roster read. */
const brokerDown = (error: unknown): boolean => error instanceof BrokerUnavailableError || error instanceof DispatchTimeoutError;

/** The failing jobs' log tails, split evenly so one noisy job cannot crowd out the rest. */
async function ciLogs(port: GitHubPort, input: WakeInput): Promise<string> {
  const failing = (await port.latestCheckRuns(input.repo, input.headSha)).filter((run) => run.status === "completed" && !isPassing(run));
  if (failing.length === 0) return "No failing check run was found at this head.";
  const budget = Math.floor((LOG_BUDGET_BYTES - (failing.length - 1)) / failing.length);
  const sections = await Promise.all(failing.map((run) => logSection(port, input.repo, run, budget)));
  return headBytes(sections.join("\n"), LOG_BUDGET_BYTES);
}

async function logSection(port: GitHubPort, repo: RepoSlug, run: CheckRun, budget: number): Promise<string> {
  const header = `== ${run.name} (${run.conclusion ?? "no conclusion"}) ${run.url}\n`;
  const log = run.workflowRunId === null ? "(not an Actions job, so no log is read)" : await port.jobLogTail(repo, run.id, LOG_TAIL_LINES).catch((error: unknown) => `(log unavailable: ${messageOf(error)})`);
  return header + tailBytes(log, Math.max(0, budget - Buffer.byteLength(header)));
}

/** The last `max` bytes, dropping a character the cut split; a log's error is at its end. */
export function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  return bytes.subarray(bytes.length - max).toString("utf8").replace(/^�+/, "");
}

function headBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  return bytes.subarray(0, max).toString("utf8").replace(/�+$/, "");
}

/** Files the PR changed that the base also changed since the merge base: the likely conflicts. */
async function conflictCandidates(port: GitHubPort, input: WakeInput, pr: PullRequest): Promise<string> {
  const [prFiles, base] = await Promise.all([port.listPrFiles(input.repo, input.pr), port.compareFiles(input.repo, input.headSha, pr.baseRef)]);
  const moved = new Set(base.files);
  const touched = prFiles.flatMap((file) => [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]);
  const candidates = [...new Set(touched.filter((path) => moved.has(path)))];
  const lines = candidates.length > 0 ? candidates : ["No file both this PR and the base changed; rebase and resolve what git reports."];
  return [...lines, ...(base.truncated ? ["GitHub truncated the base comparison, so this list may be missing files."] : [])].join("\n");
}

const FixFirst = z.looseObject({ text: z.string().min(1) });

async function fencedPayload(port: GitHubPort, input: WakeInput, pr: PullRequest): Promise<string> {
  switch (input.kind) {
    case "ci-red":
      return dataFence("CI log", await ciLogs(port, input));
    case "review":
      return dataFence("review findings", FixFirst.parse(input.payload).text);
    case "conflict":
      return dataFence("conflict candidates", await conflictCandidates(port, input, pr));
    case "fix-proof":
      return dataFence("fix-proof result", JSON.stringify(input.payload ?? null, null, 2));
  }
}

const REASONS: Record<WakeRequest["kind"], (input: WakeInput, pr: PullRequest) => string> = {
  "ci-red": (input) => `CI failed at head ${input.headSha}. The failing jobs' log tails follow.`,
  review: (input) => `An independent review of head ${input.headSha} returned FIX_FIRST. Its findings follow.`,
  conflict: (input, pr) => `Head ${input.headSha} conflicts with ${pr.baseRef}. The files both sides changed follow.`,
  "fix-proof": (input) => `The fix-proof check at head ${input.headSha} did not pass. Its result follows.`,
};

interface WakeTask {
  input: WakeInput;
  pr: PullRequest;
  payload: string;
  implementer: string;
  /** Successors the store's lineage records, earliest first. */
  successors: readonly string[];
}

const HEAD_LINE = "end with a line `Head: <full sha>` naming the head you pushed.";

function resumeMessage(task: WakeTask): string {
  const { input, pr } = task;
  const intro = `Shepherd is waking you on ${input.repo}#${input.pr}. ${REASONS[input.kind](input, pr)}`;
  return `${intro}\n\n${task.payload}\n\nFix it on branch \`${pr.headRef}\`, push, and ${HEAD_LINE}`;
}

function successorBrief(task: WakeTask, predecessor: string, name: string): string {
  const { input, pr } = task;
  return [
    `You are ${name}, taking over ${input.repo}#${input.pr} from ${predecessor}, whose session has ended. ${REASONS[input.kind](input, pr)}`,
    `Push your fix to the PR's existing head branch \`${pr.headRef}\`: fetch it, commit on top of it and push to it. Do not open a new PR.`,
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

type Choice = { mode: "resume"; agent: string; message: string; sessionId: string } | { mode: "successor"; agent: string; message: string; cwd: string };

async function choose(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, newest: AgentRow, roster: readonly AgentRow[]): Promise<Choice> {
  const path = newest.transcriptExists === true && newest.sessionId !== "" ? newest.transcriptPath : null;
  const warmth = typeof path === "string" ? await (wiring.readWarmth ?? readWarmth)(path) : undefined;
  if (isWarm(warmth, deps.now(), wiring.limits ?? DEFAULT_WARMTH_LIMITS)) {
    return { mode: "resume", agent: newest.name, message: resumeMessage(task), sessionId: newest.sessionId };
  }
  const agent = successorName(task, roster);
  return { mode: "successor", agent, message: successorBrief(task, newest.name, agent), cwd: newest.cwd };
}

/** After a timeout the ask may have landed: a successor's name is on the roster, or the resumed agent is live again. */
function tookEffect(choice: Choice, roster: readonly AgentRow[]): boolean {
  const row = latestRow(choice.agent, roster);
  return choice.mode === "successor" ? row !== undefined : row !== undefined && row.presence !== "exited";
}

function wokenBy(choice: Choice): WakeStepResult {
  return { kind: "woken", agent: choice.agent, mode: choice.mode, ...(choice.mode === "resume" && { sessionId: choice.sessionId }) };
}

/** False when the broker was down or the ask timed out; any other failure is a refusal and throws. */
async function ask(agents: ImplementerAgents, choice: Choice): Promise<boolean> {
  try {
    await (choice.mode === "resume" ? agents.resume(choice.agent, choice.message) : agents.spawn(choice.agent, choice.message, choice.cwd));
    return true;
  } catch (error) {
    if (brokerDown(error)) return false;
    throw error;
  }
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

async function headMoved(port: GitHubPort, input: WakeInput): Promise<boolean> {
  const pr = await port.getPr(input.repo, input.pr).catch(() => undefined);
  return pr !== undefined && pr.headSha !== input.headSha;
}

/** A live agent is waited on and never resumed; if it pushes a new head meanwhile, it took the wake itself. */
async function wakeAgent(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, signal: AbortSignal): Promise<WakeStepResult> {
  let asked: Choice | undefined;
  for (;;) {
    const roster = await rosterWhileBrokerDown(deps, agents, signal);
    if (asked && tookEffect(asked, roster)) return wokenBy(asked);
    const newest = newestAgent(task, roster);
    if (newest === undefined) return unhandled(`no agent of ${task.implementer}'s lineage is on the roster, so no checkout is known to start a successor in`);
    if (newest.presence !== "exited") {
      if (await headMoved(deps.port, task.input)) return { kind: "woken", agent: newest.name, mode: "live", ...(newest.sessionId !== "" && { sessionId: newest.sessionId }) };
      await deps.sleep(wiring.livePollMs ?? LIVE_POLL_MS, signal);
      continue;
    }
    asked = await choose(deps, wiring, task, newest, roster);
    if (await ask(agents, asked)) return wokenBy(asked);
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

async function wakeTask(deps: ShepherdDeps, input: WakeInput, registration: Registration): Promise<WakeTask | string> {
  const pr = await deps.port.getPr(input.repo, input.pr);
  if (pr.state !== "open") return `${input.repo}#${input.pr} is no longer open`;
  if (!BRANCH.test(pr.headRef)) return `the head branch name of ${input.repo}#${input.pr} is not one a brief can carry`;
  const successors = deps.store.get().authorsOf(input.runId).filter((author) => author.role === "successor").map((author) => author.name);
  return { input, pr, payload: await fencedPayload(deps.port, input, pr), implementer: registration.implementer, successors };
}

/** Never throws but for an abort: a refusal or a failed read is `unhandled`, so the run falls back to the owner gate. */
async function wakeImplementer(deps: ShepherdDeps, wiring: WakeWiring, input: WakeInput, signal: AbortSignal): Promise<WakeStepResult> {
  const agents = wiring.agents ?? (isAbsolute(deps.agentChatBin) ? agentChatImplementers(deps.agentChatBin) : undefined);
  if (agents === undefined) return unhandled("shepherd.agentChatBin is not configured");
  try {
    const registration = deps.store.get().byRun(input.runId);
    if (registration === undefined) return unhandled(`run ${input.runId} has no shepherd registration`);
    if (!registration.policy.fixer) return unhandled("seat grants no fixer");
    const task = await wakeTask(deps, input, registration);
    return typeof task === "string" ? unhandled(task) : await wakeAgent(deps, wiring, agents, task, signal);
  } catch (error) {
    signal.throwIfAborted();
    return unhandled(`the wake was refused: ${messageOf(error)}`);
  }
}

/** A malformed input fails the step; the await step reads and never writes, so each repeats safely after a crash. */
export const wakeRoutes = (deps: ShepherdDeps, wiring: WakeWiring = {}): readonly StepRoute[] => [
  codeRoute(WAKE_STEP, deps.now, async (raw: unknown, signal) => wakeImplementer(deps, wiring, WakeInputSchema.parse(raw), signal)),
  awaitNewHeadRoute(deps, AWAIT_NEW_HEAD_STEP),
];

const Woke = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("woken"), agent: z.string(), sessionId: z.string().optional() }),
  z.looseObject({ kind: z.literal("unhandled"), reason: z.string() }),
]);

/** Wakes an agent, then waits for the head to move; `woken` means a new head exists. A second wake in one round replays at the next index. */
export const wakePhase: ShepherdPhases["wake"] = async (ctx, request) => {
  const woke = await step(ctx, `${WAKE_STEP}:${request.round}`, { ...request, runId: ctx.runId }, Woke);
  if (woke.kind !== "woken") return { kind: "unhandled", reason: woke.reason };
  const target = { repo: request.repo, pr: request.pr, headSha: request.headSha };
  const head = await step(ctx, `${AWAIT_NEW_HEAD_STEP}:${request.round}`, target, AwaitHeadResult);
  if (head.headSha === request.headSha) return { kind: "unhandled", reason: `${request.repo}#${request.pr} closed at head ${request.headSha} before a new head` };
  return { kind: "woken", agent: woke.agent, ...(woke.sessionId !== undefined && { sessionId: woke.sessionId }) };
};
