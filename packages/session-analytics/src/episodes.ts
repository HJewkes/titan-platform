import { replaceEpisodes, type EpisodeRow, type SessionGraph } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import { classifySession, type SessionClass } from "./classify-session.js";
import { readSessionContexts } from "./cost-report-queries.js";

/** Two rule sets on purpose (design section 18): workers segment by assignment, coordinators by work phase. */
export type Heuristic = "worker-v1" | "coordinator-v1";
export const HEURISTIC_VERSIONS: Readonly<Record<Heuristic, number>> = { "worker-v1": 1, "coordinator-v1": 1 };

export interface EpisodeRequest {
  offset: number;
  ts: string;
  transcriptId: number;
  contextTokens: number;
  wakeCause: string | null;
}
export interface EpisodeInbound {
  offset: number;
  ts: string;
  transcriptId: number;
  cause: string;
}
export interface EpisodeSignal {
  offset: number;
  ts: string;
  transcriptId: number;
  signal: string;
}
export interface EpisodeInput {
  requests: readonly EpisodeRequest[];
  inbounds: readonly EpisodeInbound[];
  signals: readonly EpisodeSignal[];
  /** An agent-chat spawn has a brief; anything else opens at `session_start`. */
  spawned: boolean;
}

const MINUTE_MS = 60_000;
export const IDLE_GAP_MS = 30 * MINUTE_MS;
export const CHANNEL_CLUSTER_MS = 10 * MINUTE_MS;
export const COORDINATOR_MIN_EPISODE_REQUESTS = 8;
export const COORDINATOR_MERGE_DEDUPE_REQUESTS = 15;
export const COORDINATOR_WAVE_QUIET_REQUESTS = 15;
export const CONTEXT_RESET_TOKENS = 20_000;
const DELIVERABLE_SIGNALS = new Set(["status_report", "pr_create", "commit", "doc_written", "task_wrap"]);
const ASSIGNMENT_OPENERS = new Set(["brief", "channel_followup"]);

/** Pure: the same rows always cut the same way. Rows come back in episode order. */
export function buildEpisodes(input: EpisodeInput, heuristic: Heuristic): EpisodeRow[] {
  return heuristic === "worker-v1" ? workerEpisodes(input) : coordinatorEpisodes(input);
}

/** Workers are segmented; human sessions get the coordinator rule; headless runs get none. */
export function heuristicFor(sessionClass: SessionClass): Heuristic | null {
  if (sessionClass === "agent_spawned") return "worker-v1";
  if (sessionClass === "human_interactive") return "coordinator-v1";
  return null;
}

/** The worker report's `n_assignments`: episodes an assignment opened, which is what the standing-peer overlay counts. */
export function assignmentCount(rows: readonly Pick<EpisodeRow, "openedBy">[]): number {
  return rows.filter((row) => ASSIGNMENT_OPENERS.has(row.openedBy)).length;
}

// ---------------------------------------------------------------- worker-v1

type Event =
  | { kind: "request"; offset: number; ts: string; ms: number; transcriptId: number }
  | { kind: "inbound"; offset: number; ts: string; ms: number; transcriptId: number; cause: string }
  | { kind: "signal"; offset: number; ts: string; ms: number; transcriptId: number; signal: string };

interface Draft {
  row: EpisodeRow;
  hasRequest: boolean;
}

interface WorkerState {
  drafts: Draft[];
  lastRequestMs: number | null;
  lastChannelMs: number | null;
}

/** worker-forensics-report.md section 5 and wf_analyze.py:241-251, with the status-report trigger from design section 9. */
function workerEpisodes(input: EpisodeInput): EpisodeRow[] {
  const state: WorkerState = { drafts: [], lastRequestMs: null, lastChannelMs: null };
  for (const event of timeline(input)) {
    const current = state.drafts.at(-1);
    const reason = current ? workerBoundary(event, current, state) : input.spawned ? "brief" : "session_start";
    if (reason && (!current || current.hasRequest)) state.drafts.push(openDraft(event, reason, state.drafts.length));
    absorb(state.drafts.at(-1)!, event);
    if (event.kind === "request") state.lastRequestMs = event.ms;
    if (isChannel(event)) state.lastChannelMs = event.ms;
  }
  return state.drafts.map((draft) => draft.row);
}

function workerBoundary(event: Event, current: Draft, state: WorkerState): string | null {
  if (event.kind === "request" && state.lastRequestMs !== null && event.ms - state.lastRequestMs >= IDLE_GAP_MS) return "idle_gap";
  if (!isChannel(event)) return null;
  const startsCluster = state.lastChannelMs === null || event.ms - state.lastChannelMs > CHANNEL_CLUSTER_MS;
  return startsCluster && current.row.firstStatusOffset != null ? "channel_followup" : null;
}

function isChannel(event: Event): boolean {
  return event.kind === "inbound" && event.cause === "channel_message";
}

function openDraft(event: Event, openedBy: string, episodeIndex: number): Draft {
  const assignment = ASSIGNMENT_OPENERS.has(openedBy) && event.kind === "inbound" ? event.offset : null;
  const row: EpisodeRow = {
    episodeIndex,
    heuristicVersion: HEURISTIC_VERSIONS["worker-v1"],
    startedAt: event.ts,
    endedAt: event.ts,
    startOffset: event.offset,
    endOffset: event.offset,
    openedBy,
    startTranscriptId: event.transcriptId,
    endTranscriptId: event.transcriptId,
    assignmentOffset: assignment,
    firstDeliverableOffset: null,
    firstDeliverableSignal: null,
    firstStatusOffset: null,
  };
  return { row, hasRequest: false };
}

/** The first commit is recorded as a deliverable but not as a report: commit fires early for implementers (221 of 411). */
function absorb(draft: Draft, event: Event): void {
  draft.row.endedAt = event.ts;
  draft.row.endOffset = event.offset;
  draft.row.endTranscriptId = event.transcriptId;
  if (event.kind === "request") draft.hasRequest = true;
  if (event.kind !== "signal") return;
  if (draft.row.firstDeliverableOffset == null && DELIVERABLE_SIGNALS.has(event.signal)) {
    draft.row.firstDeliverableOffset = event.offset;
    draft.row.firstDeliverableSignal = event.signal;
  }
  if (draft.row.firstStatusOffset == null && event.signal === "status_report") draft.row.firstStatusOffset = event.offset;
}

/**
 * Offsets only order events inside one transcript, so time orders first, then the transcript a
 * session resumed into, then the offset breaks ties within it.
 */
function timeline(input: EpisodeInput): Event[] {
  const events: Event[] = [
    ...input.requests.map((r) => ({ kind: "request" as const, offset: r.offset, ts: r.ts, ms: Date.parse(r.ts), transcriptId: r.transcriptId })),
    ...input.inbounds.map((i) => ({ kind: "inbound" as const, offset: i.offset, ts: i.ts, ms: Date.parse(i.ts), transcriptId: i.transcriptId, cause: i.cause })),
    ...input.signals.map((s) => ({ kind: "signal" as const, offset: s.offset, ts: s.ts, ms: Date.parse(s.ts), transcriptId: s.transcriptId, signal: s.signal })),
  ];
  return events.sort((a, b) => a.ms - b.ms || a.transcriptId - b.transcriptId || a.offset - b.offset);
}

// ---------------------------------------------------------------- coordinator-v1

interface Turn {
  request: EpisodeRequest;
  ms: number;
  signals: Set<string>;
}

interface Boundary {
  at: number;
  reason: string;
}

/** coordinator-forensics-report.md section 1, ported from co_analyze.py `segment` with `merge_lag` 0. */
function coordinatorEpisodes(input: EpisodeInput): EpisodeRow[] {
  const turns = toTurns(input);
  if (turns.length === 0) return [];
  const opens = [{ at: 0, reason: "session_start" }, ...dropShort(coordinatorBoundaries(turns), turns.length)];
  return opens.map((open, index) => {
    const first = turns[open.at]!.request;
    const last = turns[(opens[index + 1]?.at ?? turns.length) - 1]!.request;
    return {
      episodeIndex: index,
      heuristicVersion: HEURISTIC_VERSIONS["coordinator-v1"],
      startedAt: first.ts,
      endedAt: last.ts,
      startOffset: first.offset,
      endOffset: last.offset,
      startTranscriptId: first.transcriptId,
      endTranscriptId: last.transcriptId,
      openedBy: open.reason,
    };
  });
}

function coordinatorBoundaries(turns: readonly Turn[]): Boundary[] {
  const bounds: Boundary[] = [];
  let spawnedSince = false;
  let lastMerge = -Infinity;
  for (let i = 1; i < turns.length; i++) {
    const reason = coordinatorTrigger(turns, i, lastMerge) ?? (spawnedSince && waveComplete(turns, i) ? "spawn_wave_complete" : null);
    if (turns[i - 1]!.signals.has("pr_merge")) lastMerge = i;
    if (reason) {
      bounds.push({ at: i, reason });
      spawnedSince = false;
    }
    if (turns[i]!.signals.has("agent_spawn")) spawnedSince = true;
  }
  return bounds;
}

/** Checked in the source's order; the first that fires names the boundary. */
function coordinatorTrigger(turns: readonly Turn[], i: number, lastMerge: number): string | null {
  const [a, b] = [turns[i - 1]!, turns[i]!];
  if (b.ms - a.ms >= IDLE_GAP_MS) return "idle_gap";
  if (a.signals.has("pr_merge") && i - lastMerge > COORDINATOR_MERGE_DEDUPE_REQUESTS) return "pr_merge";
  if (a.signals.has("task_wrap") || a.signals.has("task_done")) return "task_wrap";
  const drop = a.request.contextTokens - b.request.contextTokens;
  if (a.request.contextTokens > 0 && drop > CONTEXT_RESET_TOKENS) return "context_reset";
  return null;
}

/** The last agent-chat traffic before a quiet run; the source also counted any agent-chat tool call, which only reaches the graph as `chat_send` or `agent_spawn`. */
function waveComplete(turns: readonly Turn[], i: number): boolean {
  return hasChatTraffic(turns[i - 1]!) && !turns.slice(i, i + COORDINATOR_WAVE_QUIET_REQUESTS).some(hasChatTraffic);
}

function hasChatTraffic(turn: Turn): boolean {
  return turn.request.wakeCause === "channel_message" || turn.signals.has("chat_send") || turn.signals.has("agent_spawn");
}

/** No episode shorter than the minimum, at either end of the session. */
function dropShort(bounds: readonly Boundary[], total: number): Boundary[] {
  const kept: Boundary[] = [];
  let last = 0;
  for (const bound of bounds) {
    if (bound.at - last < COORDINATOR_MIN_EPISODE_REQUESTS || total - bound.at < COORDINATOR_MIN_EPISODE_REQUESTS) continue;
    kept.push(bound);
    last = bound.at;
  }
  return kept;
}

/** A signal belongs to the latest request at or before it; one before any request goes to the first. */
function toTurns(input: EpisodeInput): Turn[] {
  const turns = input.requests
    .map((request) => ({ request, ms: Date.parse(request.ts), signals: new Set<string>() }))
    .sort((a, b) => a.ms - b.ms || a.request.transcriptId - b.request.transcriptId || a.request.offset - b.request.offset);
  for (const signal of input.signals) ownerOf(turns, signal)?.signals.add(signal.signal);
  return turns;
}

function ownerOf(turns: readonly Turn[], signal: EpisodeSignal): Turn | undefined {
  const ms = Date.parse(signal.ts);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.ms < ms || (turn.ms === ms && turn.request.offset <= signal.offset)) return turn;
  }
  return turns[0];
}

// ---------------------------------------------------------------- graph I/O

const IN_SESSION = "session_id = ?";

/** Main-thread requests only: a sidechain's requests belong to its subagent, not to the session's episodes. */
export function readEpisodeInput(db: Db, sessionId: string, spawned: boolean): EpisodeInput {
  const requests = db
    .prepare(
      `SELECT byte_offset AS offset, ts, transcript_id AS transcriptId, context_tokens AS contextTokens, wake_cause AS wakeCause
       FROM request_dedup WHERE ${IN_SESSION} AND is_sidechain = 0`,
    )
    .all(sessionId) as EpisodeRequest[];
  const inbounds = db
    .prepare(`SELECT byte_offset AS offset, ts, transcript_id AS transcriptId, cause FROM inbound WHERE ${IN_SESSION}`)
    .all(sessionId) as EpisodeInbound[];
  const signals = db
    .prepare(`SELECT byte_offset AS offset, ts, transcript_id AS transcriptId, signal FROM session_signal WHERE ${IN_SESSION}`)
    .all(sessionId) as EpisodeSignal[];
  return { requests, inbounds, signals, spawned };
}

export interface WrittenEpisodes {
  sessionId: string;
  heuristic: Heuristic;
  episodes: number;
}

/** Segments each session with its class's heuristic and replaces that heuristic's rows. Headless sessions are skipped. */
export function writeEpisodes(graph: SessionGraph, sessionIds: readonly string[]): WrittenEpisodes[] {
  const written: WrittenEpisodes[] = [];
  for (const [sessionId, context] of readSessionContexts(graph.db, sessionIds)) {
    const { sessionClass } = classifySession(context.facts);
    const heuristic = heuristicFor(sessionClass);
    if (!heuristic) continue;
    const rows = buildEpisodes(readEpisodeInput(graph.db, sessionId, sessionClass === "agent_spawned"), heuristic);
    written.push({ sessionId, heuristic, episodes: replaceEpisodes(graph, sessionId, heuristic, rows) });
  }
  return written;
}
