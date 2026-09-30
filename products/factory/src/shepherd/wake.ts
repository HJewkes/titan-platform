import { isAbsolute } from "node:path";
import { BrokerUnavailableError, DispatchTimeoutError, dataFence, dispatchToAgentChat, listAgents, resumeAgent, type AgentRow } from "@titan-design/agent-dispatch";
import { isPassing, type CheckRun, type GitHubPort, type PullRequest, type RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { configPath, loadConfig } from "../config.js";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "../routed-runner.js";
import { AwaitHeadResult, awaitNewHeadRoute } from "../workflows/await-head.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps, ShepherdPhases } from "./phases.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { loadSeatBook, lookupSeat } from "./seats.js";
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
/** The spellings git refuses in a ref name, among the characters `BRANCH` lets through. */
const BAD_REF = /^[-./]|\.\.|\/\/|\/\.|\.lock$|[/.]$/;
const isRefName = (name: string): boolean => BRANCH.test(name) && !BAD_REF.test(name);

/** Files a build regenerates from source; a conflict confined to them is settled by regenerating, never by hand-merging. */
const REGISTRY_FILES: ReadonlySet<string> = new Set(["CAPABILITIES.md", "site/.vitepress/reference-sidebar.json", "site/guides/capabilities.md", ".codewatch/check.json"]);
const REGISTRY_DIR = "site/reference/";
export const isRegistry = (path: string): boolean => REGISTRY_FILES.has(path) || (path.startsWith(REGISTRY_DIR) && path.length > REGISTRY_DIR.length);

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

interface Conflict {
  /** Files the PR changed that the base also changed since the merge base: the likely conflicts. */
  files: string[];
  truncated: boolean;
}

async function conflictFiles(port: GitHubPort, input: WakeInput, pr: PullRequest): Promise<Conflict> {
  const [prFiles, base] = await Promise.all([port.listPrFiles(input.repo, input.pr), port.compareFiles(input.repo, input.headSha, pr.baseRef)]);
  const moved = new Set(base.files);
  const touched = prFiles.flatMap((file) => [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]);
  return { files: [...new Set(touched.filter((path) => moved.has(path)))], truncated: base.truncated };
}

/** A truncated comparison may hide a hand-written file, so it is never generated-only. */
const generatedOnly = (conflict: Conflict): boolean => !conflict.truncated && conflict.files.length > 0 && conflict.files.every(isRegistry);

function conflictList(conflict: Conflict): string {
  const mark = !generatedOnly(conflict) && conflict.files.some(isRegistry);
  const files = conflict.files.map((path) => (mark && isRegistry(path) ? `${path} (generated registry)` : path));
  const lines = files.length > 0 ? files : ["No file both this PR and the base changed; rebase and resolve what git reports."];
  return [...lines, ...(conflict.truncated ? ["GitHub truncated the base comparison, so this list may be missing files."] : [])].join("\n");
}

const REGENERATE = "run `pnpm build` then `pnpm capabilities`, commit the regenerated files and push";

function conflictReason(input: WakeInput, conflict: Conflict): string {
  const intro = `Head ${input.headSha} conflicts with its base branch, named in the fence below.`;
  if (generatedOnly(conflict)) {
    return `${intro} The conflict is generated-only: every file both sides changed is a generated registry. Merge the base branch from origin, take the base's side of those files, ${REGENERATE}. Do not hand-merge them.`;
  }
  const registries = conflict.files.some(isRegistry) ? ` Do not hand-merge a file marked (generated registry): take the base's side of it, then ${REGENERATE}.` : "";
  return `${intro} The files both sides changed follow.${registries}`;
}

const FixFirst = z.looseObject({ text: z.string().min(1) });

/** Why the agent is woken, and the data that shows it, fenced. */
async function describe(port: GitHubPort, input: WakeInput, pr: PullRequest): Promise<{ reason: string; payload: string }> {
  const head = input.headSha;
  switch (input.kind) {
    case "ci-red":
      return { reason: `CI failed at head ${head}. The failing jobs' log tails follow.`, payload: dataFence("CI log", await ciLogs(port, input)) };
    case "review":
      return { reason: `An independent review of head ${head} returned FIX_FIRST. Its findings follow.`, payload: dataFence("review findings", FixFirst.parse(input.payload).text) };
    case "conflict": {
      const conflict = await conflictFiles(port, input, pr);
      return { reason: conflictReason(input, conflict), payload: `${dataFence("base branch", pr.baseRef)}\n\n${dataFence("conflict candidates", conflictList(conflict))}` };
    }
    case "fix-proof":
      return { reason: `The fix-proof check at head ${head} did not pass. Its result follows.`, payload: dataFence("fix-proof result", JSON.stringify(input.payload ?? null, null, 2)) };
  }
}

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

type Choice = { mode: "resume"; agent: string; message: string; sessionId: string } | { mode: "successor"; agent: string; predecessor: string; message: string; cwd: string };

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

/** After a timeout the ask may have landed: a successor's name is on the roster, or the resumed agent is live again. */
function tookEffect(choice: Choice, roster: readonly AgentRow[]): boolean {
  const row = latestRow(choice.agent, roster);
  return choice.mode === "successor" ? row !== undefined : row !== undefined && row.presence !== "exited";
}

function wokenBy(choice: Choice): WakeStepResult {
  return { kind: "woken", agent: choice.agent, mode: choice.mode, ...(choice.mode === "resume" && { sessionId: choice.sessionId }) };
}

const sameAsk = (a: Choice | undefined, b: Choice): boolean => a !== undefined && a.mode === b.mode && a.agent === b.agent;

/**
 * False when the broker was down or the ask timed out; any other failure is a refusal and throws. A refusal of a
 * re-ask is agent-chat refusing a duplicate once the earlier ask landed, so the roster decides.
 */
async function ask(deps: ShepherdDeps, agents: ImplementerAgents, choice: Choice, reask: boolean, signal: AbortSignal): Promise<boolean> {
  try {
    await (choice.mode === "resume" ? agents.resume(choice.agent, choice.message) : agents.spawn(choice.agent, choice.message, choice.cwd));
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

async function woken(deps: ShepherdDeps, agents: ImplementerAgents, task: WakeTask, choice: Choice, signal: AbortSignal): Promise<WakeStepResult> {
  await recordSuccessor(deps, agents, task, choice, signal);
  return wokenBy(choice);
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
    if (asked && tookEffect(asked, roster)) return woken(deps, agents, task, asked, signal);
    const newest = newestAgent(task, roster);
    if (newest === undefined) return unhandled(`no agent of ${task.implementer}'s lineage is on the roster, so no checkout is known to start a successor in`);
    if (newest.presence !== "exited") {
      if (await headMoved(deps.port, task.input)) return { kind: "woken", agent: newest.name, mode: "live", ...(newest.sessionId !== "" && { sessionId: newest.sessionId }) };
      await deps.sleep(wiring.livePollMs ?? LIVE_POLL_MS, signal);
      continue;
    }
    const choice = await choose(deps, wiring, task, newest, roster);
    if (typeof choice === "string") return unhandled(choice);
    const reask = sameAsk(asked, choice);
    asked = choice;
    if (await ask(deps, agents, asked, reask, signal)) return woken(deps, agents, task, asked, signal);
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

async function wakeTask(deps: ShepherdDeps, input: WakeInput, registration: Registration): Promise<WakeTask | string> {
  const pr = await deps.port.getPr(input.repo, input.pr);
  if (pr.state !== "open") return `${input.repo}#${input.pr} is no longer open`;
  if (!isRefName(pr.headRef)) return `the head branch name of ${input.repo}#${input.pr} is not one a brief can carry`;
  if (!isRefName(pr.baseRef)) return `the base branch name of ${input.repo}#${input.pr} is not a valid ref name`;
  const successors = deps.store.get().authorsOf(input.runId).filter((author) => author.role === "successor").map((author) => author.name);
  return { input, pr, ...(await describe(deps.port, input, pr)), implementer: registration.implementer, successors };
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
