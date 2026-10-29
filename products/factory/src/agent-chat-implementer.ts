import os from "node:os";
import { lastFencedJson, type AgentRole, type AgentRow } from "@titan-design/agent-dispatch";
import { claudeSourceFromPath, readSessionObservations } from "@titan-design/session-read";
import type { ReviewerMessage } from "@titan-design/review-panel";
import type { ZodType } from "zod";
import type { AgentChatAgents } from "./shepherd/agents.js";
import { finishedTurnMessages } from "./shepherd/reviewer-reader.js";
import { latestRow } from "./shepherd/wake-roster.js";
import { sleep as abortableSleep } from "./workflows/deadline.js";

/** Six hours: an implementer's slice is long work, and the run's own budget is the real cap. */
const IMPLEMENTER_TIMEOUT_MS = 6 * 60 * 60_000;
const POLL_MS = 30_000;
/** A resume returns once the broker accepts it, so the row can still read exited from the turn before for a while. */
const START_GRACE_MS = 5 * 60_000;

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
}

interface ImplementerReport {
  agent: string;
  agentId: string;
  sessionId: string;
  report: unknown;
}

/** One implementer lineage per name: start it once, then resume the same session for each fix round. */
export interface ImplementerRunner {
  start(request: ImplementerSpawn, signal: AbortSignal): Promise<ImplementerReport>;
  resume(name: string, message: string, schema: ZodType | undefined, signal: AbortSignal): Promise<ImplementerReport>;
}

/** The finished turn's messages, oldest first; none while the turn is unfinished. */
export type FinalMessages = (row: AgentRow) => Promise<readonly Pick<ReviewerMessage, "text" | "writtenAt">[]>;

interface ImplementerRunnerOptions {
  agents: Pick<AgentChatAgents, "roster" | "spawn" | "resume">;
  messages?: FinalMessages;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  startGraceMs?: number;
}

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
}

/** Polls the roster until `name` has exited with a report written since the ask; an exit with none rejects. */
async function awaitReport(options: Required<Omit<ImplementerRunnerOptions, "agents">> & Pick<ImplementerRunnerOptions, "agents">, wait: Wait): Promise<ImplementerReport> {
  let sawRunning = false;
  for (;;) {
    const elapsed = options.now() - wait.askedAt;
    if (elapsed > options.timeoutMs) throw new Error(`${wait.name} sent no report within ${Math.round(options.timeoutMs / 60_000)} minutes`);
    const row = latestRow(wait.name, await options.agents.roster());
    if (row?.status === "retired") throw new Error(`${wait.name} was retired before it reported`);
    if (row && row.presence !== "exited") sawRunning = true;
    if (row?.presence === "exited") {
      const report = reportSince(await options.messages(row), wait.askedAt);
      if (report) return { agent: wait.name, agentId: row.agentId, sessionId: row.sessionId, report: checked(wait.schema, report.found) };
      if (sawRunning || elapsed >= options.startGraceMs) throw new Error(`${wait.name} exited with no fenced JSON report`);
    }
    await options.sleep(options.pollMs, wait.signal);
  }
}

/**
 * The implementer route's runner over agent-chat: spawn on a worktree profile, wait for the exit, read the report.
 * A name already on the roster is the same lineage continuing: an exited one is resumed with the brief and a live one is
 * waited on, so a re-dispatch after a park never spawns a second agent under the name.
 */
export function agentChatImplementerRunner(options: ImplementerRunnerOptions): ImplementerRunner {
  const resolved = { messages: transcriptFinalMessages(), now: Date.now, sleep: abortableSleep, pollMs: POLL_MS, timeoutMs: IMPLEMENTER_TIMEOUT_MS, startGraceMs: START_GRACE_MS, ...options };
  const resume = async (name: string, message: string, schema: ZodType | undefined, signal: AbortSignal) => {
    const askedAt = resolved.now();
    await resolved.agents.resume(name, message);
    return awaitReport(resolved, { name, askedAt, schema, signal });
  };
  return {
    async start(request, signal) {
      const existing = latestRow(request.name, await resolved.agents.roster());
      const askedAt = resolved.now();
      if (existing?.presence === "exited" && existing.status !== "retired") return resume(request.name, request.brief, request.schema, signal);
      if (existing && existing.status !== "retired") return awaitReport(resolved, { name: request.name, askedAt, schema: request.schema, signal });
      const { name, profile, brief, cwd, task } = request;
      await resolved.agents.spawn({ name, profile, brief, cwd, role: request.role ?? "implementer", ...(task !== undefined && { task }) });
      return awaitReport(resolved, { name: request.name, askedAt, schema: request.schema, signal });
    },
    resume,
  };
}
