import os from "node:os";
import { lastFencedJson, type AgentRole, type AgentRow } from "@titan-design/agent-dispatch";
import { claudeSourceFromPath, readSessionObservations } from "@titan-design/session-read";
import type { ReviewerMessage } from "@titan-design/review-panel";
import { CodeStepFailure, type StepUsage } from "@titan-design/workflow";
import type { ZodType } from "zod";
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
  /** What the agent may spend on this turn; past it the agent is retired mid-turn. Absent never stops it. */
  budgetUsd?: number;
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
  resume(name: string, message: string, schema: ZodType | undefined, signal: AbortSignal, budgetUsd?: number): Promise<ImplementerReport>;
}

/** The finished turn's messages, oldest first; none while the turn is unfinished. */
export type FinalMessages = (row: AgentRow) => Promise<readonly Pick<ReviewerMessage, "text" | "writtenAt">[]>;

interface ImplementerRunnerOptions {
  agents: Pick<AgentChatAgents, "roster" | "spawn" | "resume" | "retire">;
  messages?: FinalMessages;
  meter?: StepMeter;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  startGraceMs?: number;
  spawnRetry?: SpawnRetry;
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
  /** The newest row the wait saw, kept so a turn that ends in an error can still be metered. */
  row?: AgentRow;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Retires the agent; a refusal (never forced, so unpushed work refuses it) is said in the failure, because it may still be spending. */
async function retireOverBudget(options: ResolvedOptions, name: string, why: string): Promise<never> {
  try {
    await options.agents.retire?.(name);
  } catch (error) {
    throw new Error(`${name} ${why}, and retiring it was refused, so it may still be running: ${messageOf(error)}`);
  }
  throw new Error(`${name} was retired: it ${why}`);
}

/** A meter that cannot be read this poll says nothing; only spend it did read, or spend it cannot price, retires the agent. */
async function stopOverBudget(options: ResolvedOptions, wait: Wait, row: AgentRow): Promise<void> {
  const { budgetUsd } = wait;
  if (budgetUsd === undefined || row.presence === "exited") return;
  const spent = await options.meter(row, wait.askedAt).catch(() => undefined);
  if (spent?.costUnknown) await retireOverBudget(options, wait.name, `has spend with no price, so its $${budgetUsd.toFixed(2)} budget cannot be checked`);
  if (spent && spent.costUsd > budgetUsd) await retireOverBudget(options, wait.name, `spent $${spent.costUsd.toFixed(2)} of its $${budgetUsd.toFixed(2)} budget`);
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
  return (await options.meter(wait.row, wait.askedAt).catch(() => undefined)) ?? UNMETERED;
}

/** Waits for the report and prices the turn, on a failed turn too, so a budget counts what the failure already spent. */
async function meteredReport(options: ResolvedOptions, wait: Wait): Promise<ImplementerReport> {
  try {
    const report = await awaitReport(options, wait);
    return { ...report, usage: await turnUsage(options, wait) };
  } catch (error) {
    if (wait.signal.aborted) throw error;
    throw new CodeStepFailure(messageOf(error), await turnUsage(options, wait));
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
  const waits = { pollMs: POLL_MS, timeoutMs: IMPLEMENTER_TIMEOUT_MS, startGraceMs: START_GRACE_MS, spawnRetry: SPAWN_RETRY };
  const defaults = { messages: transcriptFinalMessages(), meter: transcriptMeter, now: Date.now, sleep: abortableSleep, ...waits };
  const resolved: ResolvedOptions = { ...defaults, ...options };
  const resume = async (name: string, message: string, schema: ZodType | undefined, signal: AbortSignal, budgetUsd?: number) => {
    const askedAt = await whenAdmitted(resolved, name, signal, () => resolved.agents.resume(name, message));
    return meteredReport(resolved, { name, askedAt, schema, signal, budgetUsd });
  };
  return {
    async start(request, signal) {
      const existing = latestRow(request.name, await resolved.agents.roster());
      const askedAt = resolved.now();
      const { budgetUsd } = request;
      if (existing?.presence === "exited" && existing.status !== "retired") return resume(request.name, request.brief, request.schema, signal, budgetUsd);
      if (existing && existing.status !== "retired") return meteredReport(resolved, { name: request.name, askedAt, schema: request.schema, signal, budgetUsd });
      const { name, profile, brief, cwd, task } = request;
      const spawn = { name, profile, brief, cwd, role: request.role ?? "implementer", ...(task !== undefined && { task }) };
      const admittedAt = await whenAdmitted(resolved, name, signal, () => resolved.agents.spawn(spawn));
      return meteredReport(resolved, { name, askedAt: admittedAt, schema: request.schema, signal, budgetUsd });
    },
    resume,
  };
}
