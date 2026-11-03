import os from "node:os";
import { lastFencedJson, type AgentRole, type AgentRow } from "@titan-design/agent-dispatch";
import { claudeSourceFromPath, readSessionObservations } from "@titan-design/session-read";
import type { ReviewerMessage } from "@titan-design/review-panel";
import { CodeStepFailure, type StepUsage } from "@titan-design/workflow";
import type { ZodType } from "zod";
import { AgentLeftRunning, messageOf, stopAgent } from "./agent-stop.js";
import type { TellOwner } from "./owner-ops/standing-answers.js";
import type { AgentChatAgents } from "./shepherd/agents.js";
import { accountLimitRefusal } from "./shepherd/account-fallback.js";
import { believedReset, parseLimitReset } from "./shepherd/account-limit.js";
import { finishedTurnMessages } from "./shepherd/reviewer-reader.js";
import { SpawnDeferred } from "./shepherd/spawn-gate.js";
import { latestRow } from "./shepherd/wake-roster.js";
import { transcriptMeter, UNMETERED, type StepMeter } from "./step-usage.js";
import { sleep as abortableSleep } from "./workflows/deadline.js";

/** Six hours: an implementer's slice is long work, and the run's own budget is the real cap. */
const IMPLEMENTER_TIMEOUT_MS = 6 * 60 * 60_000;
const POLL_MS = 30_000;
/** A resume returns once the broker accepts it, so the row can still read exited from the turn before for a while. */
const START_GRACE_MS = 5 * 60_000;
/** Three polls, about a minute and a half, for an agent told to stop to push and exit before its retire is tried again. */
const STOP_GRACE_POLLS = 3;
/** Ten polls, about five minutes, of a transcript that will not read before a budget stops trusting it. */
const MAX_UNREAD_POLLS = 10;
/**
 * A spawn-gate deferral (load, memory pressure, the admit window) reads the machine now, not the slice: wait and ask again,
 * doubling the wait up to `maxMs`, and give up once the next wait would pass `totalMs` since the first ask.
 */
const SPAWN_RETRY: SpawnRetry = { firstMs: 60_000, maxMs: 10 * 60_000, totalMs: 60 * 60_000 };

interface SpawnRetry {
  firstMs: number;
  maxMs: number;
  totalMs: number;
}

interface ImplementerSpawn {
  /** The agent's name; its worktree branch and its lineage follow it. */
  name: string;
  profile: string;
  cwd: string;
  brief: string;
  /** Recorded on the agent's row as `--task`. */
  task?: string;
  /** The report's shape; a report that fails it rejects naming each issue. */
  schema?: ZodType;
  /** Recorded as `--role`; a read-only reviewer runs through the same wait and report read. */
  role?: AgentRole;
  turn?: TurnLimits;
}

interface TurnLimits {
  /** What the agent may spend on this turn; past it the agent is stopped mid-turn. Absent never stops it. */
  budgetUsd?: number;
  /** When the step first started, which a restart keeps: spend from then on is this turn's, however late the wait attached. */
  firstStartedAtMs?: number;
}

interface ImplementerReport {
  agent: string;
  agentId: string;
  sessionId: string;
  report: unknown;
  /** What this turn alone cost; a failed turn carries it on its `CodeStepFailure` instead. */
  usage: StepUsage;
}

/** One implementer lineage per name: start it once, then resume the same session for each fix round. */
export interface ImplementerRunner {
  start(request: ImplementerSpawn, signal: AbortSignal): Promise<ImplementerReport>;
  resume(name: string, message: string, schema: ZodType | undefined, signal: AbortSignal, turn?: TurnLimits): Promise<ImplementerReport>;
}

/** The finished turn's messages, oldest first; none while the turn is unfinished. */
export type FinalMessages = (row: AgentRow) => Promise<readonly Pick<ReviewerMessage, "text" | "writtenAt">[]>;

interface ImplementerRunnerOptions {
  agents: Pick<AgentChatAgents, "roster" | "spawn" | "resume" | "message" | "retire">;
  /** Told about an agent still live after every way of stopping it failed. */
  tellOwner: TellOwner;
  messages?: FinalMessages;
  meter?: StepMeter;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  startGraceMs?: number;
  spawnRetry?: SpawnRetry;
  stopGracePolls?: number;
  maxUnreadPolls?: number;
}

type ResolvedOptions = Required<Omit<ImplementerRunnerOptions, "agents">> & Pick<ImplementerRunnerOptions, "agents">;

/** Reads the transcript the roster row names, through the same finished-turn rule Shepherd reads reviewers by. */
function transcriptFinalMessages(namespace = os.hostname()): FinalMessages {
  return async (row) => {
    if (row.transcriptExists !== true || !row.transcriptPath) return [];
    const turn = finishedTurnMessages(row.agentId);
    for await (const observation of readSessionObservations(claudeSourceFromPath(row.transcriptPath, namespace), {})) turn.add(observation);
    return turn.result();
  };
}

/** The newest message written since `askedAt` that carries a fenced JSON report; a malformed block rejects. */
function reportSince(messages: readonly Pick<ReviewerMessage, "text" | "writtenAt">[], askedAt: number): { found: unknown } | undefined {
  for (const message of [...messages].reverse()) {
    if (!(message.writtenAt >= askedAt)) continue;
    let parsed: unknown;
    try {
      parsed = lastFencedJson(message.text);
    } catch (error) {
      throw new Error(`the report's fenced JSON does not parse: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed !== undefined) return { found: parsed };
  }
  return undefined;
}

function checked(schema: ZodType | undefined, report: unknown): unknown {
  if (!schema) return report;
  const parsed = schema.safeParse(report);
  if (parsed.success) return parsed.data;
  throw new Error(`the report does not match its schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
}

interface Wait {
  name: string;
  askedAt: number;
  schema: ZodType | undefined;
  signal: AbortSignal;
  budgetUsd: number | undefined;
  /** The start of the turn's spend; earlier than `askedAt` when the wait attached to a turn already running. */
  meterFromMs: number;
  /** The newest row the wait saw, kept so a turn that ends in an error can still be metered. */
  row?: AgentRow;
  /** The newest good meter reading, a floor if a later read fails. */
  spent?: StepUsage;
  unreadPolls: number;
}

async function readMeter(options: ResolvedOptions, wait: Wait, row: AgentRow): Promise<StepUsage | undefined> {
  const spent = await options.meter(row, wait.meterFromMs).catch(() => undefined);
  wait.unreadPolls = spent ? 0 : wait.unreadPolls + 1;
  if (spent) wait.spent = spent;
  return spent;
}

/** Why a budget can no longer hold; a few unread polls are transient, but a meter that stays dark must not read as under budget. */
function overBudget(spent: StepUsage | undefined, budgetUsd: number, unreadPolls: number, maxUnreadPolls: number): string | undefined {
  const budget = `$${budgetUsd.toFixed(2)} budget`;
  if (spent?.costUnknown) return `has spend with no price, so its ${budget} cannot be checked`;
  if (spent && spent.costUsd > budgetUsd) return `spent $${spent.costUsd.toFixed(2)} of its ${budget}`;
  return unreadPolls >= maxUnreadPolls ? `could not be metered for ${unreadPolls} polls in a row, so its ${budget} cannot be checked` : undefined;
}

async function stopOverBudget(options: ResolvedOptions, wait: Wait, row: AgentRow): Promise<void> {
  const { budgetUsd, name, signal } = wait;
  if (budgetUsd === undefined || row.presence === "exited") return;
  const why = overBudget(await readMeter(options, wait, row), budgetUsd, wait.unreadPolls, options.maxUnreadPolls);
  if (why === undefined) return;
  const observe = async (seen: AgentRow) => {
    wait.row = seen;
    await readMeter(options, wait, seen);
  };
  await stopAgent(options, { name, stepId: String(wait.askedAt), why, signal, observe });
}

/** Polls the roster until `name` has exited with a report written since the ask; an exit with none rejects. */
async function awaitReport(options: ResolvedOptions, wait: Wait): Promise<Omit<ImplementerReport, "usage">> {
  let sawRunning = false;
  for (;;) {
    const elapsed = options.now() - wait.askedAt;
    if (elapsed > options.timeoutMs) throw new Error(`${wait.name} sent no report within ${Math.round(options.timeoutMs / 60_000)} minutes`);
    const row = latestRow(wait.name, await options.agents.roster());
    wait.row = row ?? wait.row;
    if (row?.status === "retired") throw new Error(`${wait.name} was retired before it reported`);
    if (row) await stopOverBudget(options, wait, row);
    if (row && row.presence !== "exited") sawRunning = true;
    if (row?.presence === "exited") {
      const report = reportSince(await options.messages(row), wait.askedAt);
      if (report) return { agent: wait.name, agentId: row.agentId, sessionId: row.sessionId, report: checked(wait.schema, report.found) };
      if (sawRunning || elapsed >= options.startGraceMs) throw new Error(`${wait.name} exited with no fenced JSON report`);
    }
    await options.sleep(options.pollMs, wait.signal);
  }
}

/** The turn's spend once it is over; a turn that ran and cannot be read is unmetered, never free. */
async function turnUsage(options: ResolvedOptions, wait: Wait): Promise<StepUsage> {
  if (!wait.row) return UNMETERED;
  const read = await options.meter(wait.row, wait.meterFromMs).catch(() => undefined);
  if (read) return read;
  return wait.spent ? { ...wait.spent, costUnknown: true } : UNMETERED;
}

/** Waits for the report and prices the turn, on a failed turn too, so a budget counts what the failure already spent. */
async function meteredReport(options: ResolvedOptions, wait: Wait): Promise<ImplementerReport> {
  try {
    const report = await awaitReport(options, wait);
    return { ...report, usage: await turnUsage(options, wait) };
  } catch (error) {
    if (wait.signal.aborted) throw error;
    const usage = await turnUsage(options, wait);
    throw new CodeStepFailure(messageOf(error), error instanceof AgentLeftRunning ? { ...usage, costUnknown: true } : usage);
  }
}

/** The epoch ms an account-limit refusal says the account resets, when it names one that is believed; otherwise undefined. */
function limitResetOf(error: unknown, now: number): number | undefined {
  const refusal = accountLimitRefusal(error);
  const reset = refusal && parseLimitReset(refusal.message, now);
  return reset !== undefined && believedReset(reset, now) === reset ? reset : undefined;
}

/**
 * Runs `start` once the spawn gate admits it, and returns when that admitted ask was made, so a report is read from then on.
 * An account-limit refusal that names its reset wakes at the reset, outside the retry bound: the account, not the machine, is what the wait is for.
 */
async function whenAdmitted(options: ResolvedOptions, name: string, signal: AbortSignal, start: () => Promise<void>): Promise<number> {
  const firstAsk = options.now();
  for (let waitMs = options.spawnRetry.firstMs; ; waitMs = Math.min(waitMs * 2, options.spawnRetry.maxMs)) {
    const askedAt = options.now();
    try {
      await start();
      return askedAt;
    } catch (error) {
      const resetsAt = limitResetOf(error, askedAt);
      if (resetsAt !== undefined) {
        await options.sleep(resetsAt - askedAt, signal);
        continue;
      }
      if (!(error instanceof SpawnDeferred) && accountLimitRefusal(error) === undefined) throw error;
      const minutes = Math.round(options.spawnRetry.totalMs / 60_000);
      if (askedAt - firstAsk + waitMs > options.spawnRetry.totalMs) throw new Error(`${name} was not admitted within ${minutes} minutes: ${error instanceof Error ? error.message : String(error)}`);
      await options.sleep(waitMs, signal);
    }
  }
}

/**
 * The implementer route's runner over agent-chat: spawn on a worktree profile, wait for the exit, read the report.
 * A name already on the roster is the same lineage continuing: an exited one is resumed with the brief and a live one is
 * waited on, so a re-dispatch after a park never spawns a second agent under the name.
 */
export function agentChatImplementerRunner(options: ImplementerRunnerOptions): ImplementerRunner {
  const waits = { pollMs: POLL_MS, timeoutMs: IMPLEMENTER_TIMEOUT_MS, startGraceMs: START_GRACE_MS, spawnRetry: SPAWN_RETRY, stopGracePolls: STOP_GRACE_POLLS, maxUnreadPolls: MAX_UNREAD_POLLS };
  const defaults = { messages: transcriptFinalMessages(), meter: transcriptMeter, now: Date.now, sleep: abortableSleep, ...waits };
  const resolved: ResolvedOptions = { ...defaults, ...options };
  const waitFor = (name: string, askedAt: number, schema: ZodType | undefined, signal: AbortSignal, turn: TurnLimits) =>
    meteredReport(resolved, { name, askedAt, schema, signal, budgetUsd: turn.budgetUsd, meterFromMs: turn.firstStartedAtMs ?? askedAt, unreadPolls: 0 });
  const resume = async (name: string, message: string, schema: ZodType | undefined, signal: AbortSignal, turn: TurnLimits = {}) => {
    const askedAt = await whenAdmitted(resolved, name, signal, () => resolved.agents.resume(name, message));
    return waitFor(name, askedAt, schema, signal, turn);
  };
  return {
    async start(request, signal) {
      const existing = latestRow(request.name, await resolved.agents.roster());
      const askedAt = resolved.now();
      const { turn = {} } = request;
      if (existing?.presence === "exited" && existing.status !== "retired") return resume(request.name, request.brief, request.schema, signal, turn);
      if (existing && existing.status !== "retired") return waitFor(request.name, askedAt, request.schema, signal, turn);
      const { name, profile, brief, cwd, task } = request;
      const spawn = { name, profile, brief, cwd, role: request.role ?? "implementer", ...(task !== undefined && { task }) };
      const admittedAt = await whenAdmitted(resolved, name, signal, () => resolved.agents.spawn(spawn));
      return waitFor(name, admittedAt, request.schema, signal, turn);
    },
    resume,
  };
}
