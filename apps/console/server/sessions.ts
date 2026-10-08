import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { EXIT, defineCommand } from "@titan-design/registry";
import { SessionTimelineAccumulator, priceRequest, type SessionTimeline } from "@titan-design/session-analytics";
import { SessionGraphNotMigratedError, openSessionGraph, type SessionGraph } from "@titan-design/session-graph";
import {
  RELATIONS, claudeSourceFromPath, claudeTranscriptRoots, expandHome, findClaudeSessionSource, readSessionObservations, sessionRef,
  type SessionSourceDescriptor, type TranscriptRoot,
} from "@titan-design/session-read";

export interface SessionsSource {
  /** The session graph another process writes; it is only ever opened read-only, once per request. */
  graphPath: string;
  /** Claude config roots searched for a transcript the graph has not indexed yet. */
  roots?: () => readonly TranscriptRoot[];
  /** Expands the `~/` that the graph stores transcript paths under. */
  home?: string;
  now?: () => number;
}

type DegradedReason ="graph-missing" | "graph-not-migrated" | "graph-unreadable" | "transcript-missing";

interface Degraded {
  reason: DegradedReason;
  detail: string;
}

interface ModelUsage {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
  /** False when no price row covers the model; `costUsd` is then 0. */
  priced: boolean;
}

interface SessionRow {
  sessionId: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  turnCount: number;
  /** As the graph stores it, `~`-relative; null when the graph holds no transcript row. */
  transcript: { path: string; status: string } | null;
  agentName: string | null;
  parentSessionId: string | null;
  taskIds: string[];
  /** `pr:<owner>/<repo>#<n>` refs from the session's `linked` edges. */
  prs: string[];
  usage: ModelUsage[];
  costUsd: number;
}

export interface SessionsListResult {
  sessions: SessionRow[];
  /** Pass as `before` for the next page; null on the last page. */
  nextBefore: string | null;
  degraded: Degraded | null;
}

export type SessionTimelineResult =
  | { status: "ok"; sessionId: string; source: "graph" | "filesystem"; path: string; session: SessionRow | null; timeline: SessionTimeline }
  | { status: "degraded"; sessionId: string; degraded: Degraded; session: SessionRow | null };

/** A Claude session id is one filename component; anything else could walk out of the projects directory. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const listArgs = z.object({
  limit: z.number().int().positive().max(200).default(50),
  before: z.string().min(1).optional().describe("Keyset cursor: only sessions started before this ISO timestamp"),
  agent: z.string().min(1).optional().describe("Only sessions run by this agent-chat agent name"),
});

/** Both commands open the graph read-only per request and close it before any transcript read. */
export function sessionsCommands(source: SessionsSource) {
  return {
    "sessions.list": defineCommand({
      name: "sessions.list",
      description: "Indexed sessions, newest first, with agent, tasks, linked PRs and per-model token usage from the session graph",
      args: listArgs,
      result: z.custom<SessionsListResult>(),
      run: (args) => listSessions(source, args),
    }),
    "sessions.timeline": defineCommand({
      name: "sessions.timeline",
      description: "One session's timeline from its transcript, found through the session graph or, for a live session, the Claude config roots",
      args: z.object({ sessionId: z.string().regex(SESSION_ID) }),
      result: z.custom<SessionTimelineResult>(),
      run: ({ sessionId }) => readTimeline(source, sessionId),
    }),
  };
}

type GraphRead<T> = { ok: true; value: T } | { ok: false; degraded: Degraded };

/** `read` is synchronous so no statement outlives it: a reader held across an await would stall the writer's checkpoints. */
async function readGraph<T>(graphPath: string, read: (graph: SessionGraph) => T): Promise<GraphRead<T>> {
  const info = await stat(graphPath).catch(() => null);
  if (!info?.isFile()) return { ok: false, degraded: { reason: "graph-missing", detail: `No session graph at ${graphPath}` } };
  let graph: SessionGraph;
  try {
    graph = openSessionGraph(graphPath, { readonly: true });
  } catch (error) {
    const reason = error instanceof SessionGraphNotMigratedError ? "graph-not-migrated" : "graph-unreadable";
    return { ok: false, degraded: { reason, detail: error instanceof Error ? error.message : String(error) } };
  }
  try {
    return { ok: true, value: read(graph) };
  } finally {
    graph.db.close();
  }
}

async function listSessions(source: SessionsSource, args: z.infer<typeof listArgs>): Promise<SessionsListResult> {
  const read = await readGraph(source.graphPath, (graph) => pageOf(graph, args, source.now ?? Date.now));
  if (!read.ok) return { sessions: [], nextBefore: null, degraded: read.degraded };
  const sessions = read.value;
  const last = sessions.at(-1);
  const nextBefore = sessions.length === args.limit && last?.startedAt ? last.startedAt : null;
  return { sessions, nextBefore, degraded: null };
}

const ROW_SELECT = `
  SELECT s.session_id, s.started_at, s.ended_at, s.ai_title, s.cwd, s.git_branch, s.turn_count,
         t.source_key, t.status, o.agent_name, o.parent_session_id, o.task_ids
  FROM session s
  LEFT JOIN transcript t ON t.source_id = s.transcript_id
  LEFT JOIN session_origin o ON o.session_id = s.session_id`;

interface RawRow {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  ai_title: string | null;
  cwd: string | null;
  git_branch: string | null;
  turn_count: number;
  source_key: string | null;
  status: string | null;
  agent_name: string | null;
  parent_session_id: string | null;
  task_ids: string | null;
}

/** The WHERE clause is built per call: an `(? IS NULL OR …)` form turns the started_at seek into a scan. */
function pageOf(graph: SessionGraph, args: z.infer<typeof listArgs>, now: () => number): SessionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.before !== undefined) {
    where.push("s.started_at < ?");
    params.push(args.before);
  }
  if (args.agent !== undefined) {
    where.push("o.agent_name = ?");
    params.push(args.agent);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `${ROW_SELECT} ${clause} ORDER BY s.started_at DESC LIMIT ?`;
  const rows = graph.db.prepare(sql).all(...params, args.limit) as RawRow[];
  return withDetail(graph, rows, now);
}

function lookupSession(graph: SessionGraph, sessionId: string, now: () => number): SessionRow | null {
  const row = graph.db.prepare(`${ROW_SELECT} WHERE s.session_id = ?`).get(sessionId) as RawRow | undefined;
  return row ? (withDetail(graph, [row], now)[0] ?? null) : null;
}

interface RawUsage {
  session_id: string;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  request_count: number;
}

function withDetail(graph: SessionGraph, rows: readonly RawRow[], now: () => number): SessionRow[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.session_id);
  const usage = graph.db
    .prepare(`SELECT session_id, model, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, request_count
              FROM session_model_usage WHERE session_id IN (${ids.map(() => "?").join(", ")}) ORDER BY model`)
    .all(...ids) as RawUsage[];
  const pricedAt = new Date(now()).toISOString();
  return rows.map((row) => {
    const models = usage.filter((u) => u.session_id === row.session_id).map((u) => priced(u, row.started_at ?? pricedAt));
    const prs = graph.edges.from(sessionRef(row.session_id)).filter((edge) => edge.relation === RELATIONS.LINKED).map((edge) => edge.targetRef);
    return toSessionRow(row, models, prs);
  });
}

function priced(usage: RawUsage, at: string): ModelUsage {
  const tokens = {
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_tokens,
    cacheCreationTokens: usage.cache_creation_tokens,
    outputTokens: usage.output_tokens,
  };
  const { costUsd, priced: hasPrice } = priceRequest(tokens, usage.model, at);
  return { model: usage.model, ...tokens, requests: usage.request_count, costUsd, priced: hasPrice };
}

function toSessionRow(row: RawRow, usage: ModelUsage[], prs: string[]): SessionRow {
  return {
    sessionId: row.session_id,
    title: row.ai_title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    turnCount: row.turn_count,
    transcript: row.source_key === null ? null : { path: row.source_key, status: row.status ?? "ok" },
    agentName: row.agent_name,
    parentSessionId: row.parent_session_id,
    taskIds: parseTaskIds(row.task_ids),
    prs,
    usage,
    costUsd: usage.reduce((sum, model) => sum + model.costUsd, 0),
  };
}

function parseTaskIds(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Graph first; the filesystem only for a session the graph has not indexed, since the index lags live sessions by minutes. */
async function readTimeline(source: SessionsSource, sessionId: string): Promise<SessionTimelineResult> {
  const read = await readGraph(source.graphPath, (graph) => lookupSession(graph, sessionId, source.now ?? Date.now));
  const session = read.ok ? read.value : null;
  const roots = (source.roots ?? claudeTranscriptRoots)();
  if (session) return timelineOfIndexed(session, roots, source.home ?? os.homedir());
  const found = locateTranscript(sessionId, roots);
  if (found) return { status: "ok", sessionId, source: "filesystem", path: found.path, session: null, timeline: await timelineOf(found) };
  if (!read.ok) return { status: "degraded", sessionId, degraded: read.degraded, session: null };
  throw Object.assign(new Error(`No session ${sessionId} in the session graph or under any Claude config root`), { code: EXIT.NOINPUT });
}

async function timelineOfIndexed(session: SessionRow, roots: readonly TranscriptRoot[], home: string): Promise<SessionTimelineResult> {
  const { sessionId, transcript } = session;
  const file = transcript ? expandHome(transcript.path, home) : null;
  const present = file !== null && transcript?.status !== "missing" && (await stat(file).catch(() => null))?.isFile() === true;
  if (!file || !present) {
    const detail = transcript ? `The transcript at ${transcript.path} is gone; the graph keeps its rollups` : "The graph holds no transcript for this session";
    return { status: "degraded", sessionId, degraded: { reason: "transcript-missing", detail }, session };
  }
  const descriptor = claudeSourceFromPath(file, accountOf(file, roots));
  return { status: "ok", sessionId, source: "graph", path: file, session, timeline: await timelineOf(descriptor) };
}

function accountOf(file: string, roots: readonly TranscriptRoot[]): string {
  return roots.find(({ root }) => file.startsWith(`${root}${path.sep}`))?.account ?? "default";
}

/** Two roots holding one id would make the timeline ambiguous, so that is an error rather than a pick. */
function locateTranscript(sessionId: string, roots: readonly TranscriptRoot[]): SessionSourceDescriptor | null {
  const found: SessionSourceDescriptor[] = [];
  for (const { root, account } of roots) {
    // The cwd is unknown here; the filesystem root slugs to no project, so the lookup scans every project directory.
    const lookup = findClaudeSessionSource({
      cwd: path.parse(root).root,
      configDir: path.dirname(root),
      conversation: { harness: "claude-code", namespace: account, nativeId: sessionId },
    });
    if (lookup.status === "unavailable") throw new Error(lookup.reason);
    if (lookup.status === "found") found.push(lookup.source);
  }
  if (found.length > 1) throw new Error(`Session ${sessionId} has a transcript under more than one Claude config root`);
  return found[0] ?? null;
}

async function timelineOf(source: SessionSourceDescriptor): Promise<SessionTimeline> {
  const accumulator = new SessionTimelineAccumulator();
  for await (const observation of readSessionObservations(source)) accumulator.add(observation);
  return accumulator.result();
}
