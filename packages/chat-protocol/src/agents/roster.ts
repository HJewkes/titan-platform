import { foldAgentRecords, type AgentRecord } from "./lifecycle.js";
import type { AgentRosterEntry, AgentRosterSnapshot, AgentState, BrokerEvent, BrokerSession, HistoryWindow } from "./types.js";

/** Below this uptime the broker's in-memory registry is still refilling after a restart. */
export const RECONNECT_WINDOW_MS = 10_000;

export interface SeatPrefix {
  seat: string;
  prefix: string;
}

export interface RosterInput {
  sessions: readonly BrokerSession[];
  brokerUptimeMs: number | null;
  events: readonly BrokerEvent[];
  historyLimit: number;
  now: number;
  /** Seats own the agents named `<prefix>-...`; the longest matching prefix wins. */
  seatPrefixes?: readonly SeatPrefix[];
  /** A priced transcript total for a Claude Code session id, from session-analytics. */
  costOf?: (claudeSessionId: string) => number | undefined;
}

const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/;

/** Live sessions first, then agents known only from history, each with where its state came from. */
export function foldRoster(input: RosterInput): AgentRosterSnapshot {
  const records = foldAgentRecords(input.events);
  const live = input.sessions.map((session) => presenceEntry(session, records.get(session.name), input));
  const present = new Set(input.sessions.map((session) => session.name));
  const past = [...records.values()]
    .filter((record) => !present.has(record.name))
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
    .map((record) => historyEntry(record, input));
  const uptime = input.brokerUptimeMs;
  return {
    agents: [...live, ...past],
    brokerUptimeMs: uptime,
    reconnecting: uptime !== null && uptime < RECONNECT_WINDOW_MS,
    history: historyWindowOf(input.events, input.historyLimit),
    generatedAt: input.now,
  };
}

export function historyWindowOf(events: readonly BrokerEvent[], limit: number): HistoryWindow {
  const oldest = events.reduce<number | null>((min, event) => (min === null || event.at < min ? event.at : min), null);
  return { events: events.length, limit, oldestAt: oldest };
}

function presenceEntry(session: BrokerSession, record: AgentRecord | undefined, input: RosterInput): AgentRosterEntry {
  const claudeSessionId = session.observed?.claudeSessionId ?? record?.meta["session_id"] ?? null;
  return {
    ...identity(session.name, claudeSessionId, session.registeredAt),
    ...spawnFacts(record, input),
    ...costFacts(claudeSessionId, record, input),
    state: session.status,
    stateSource: "presence",
    workingOn: session.workingOn,
    cwd: session.cwd,
    gitBranch: session.observed?.gitBranch ?? null,
    taskId: taskIdOf(session.declared, session.workingOn),
    registeredAt: session.registeredAt,
    lastEventAt: Math.max(input.now - session.idleMs, record?.lastEventAt ?? 0),
    idleMs: session.idleMs,
    dnd: session.dnd ?? false,
    provisional: session.provisional ?? false,
    tags: (session.tags ?? []).map(({ tag }) => tag),
  };
}

function historyEntry(record: AgentRecord, input: RosterInput): AgentRosterEntry {
  const claudeSessionId = record.meta["session_id"] || null;
  const workingOn = record.brief.split("\n", 1)[0] || null;
  return {
    ...identity(record.name, claudeSessionId, record.spawnedAt),
    ...spawnFacts(record, input),
    ...costFacts(claudeSessionId, record, input),
    state: historyState(record.lifecycle),
    stateSource: "history",
    workingOn,
    cwd: record.meta["cwd"] || null,
    gitBranch: null,
    taskId: taskIdOf(undefined, workingOn),
    registeredAt: null,
    lastEventAt: record.lastEventAt,
    idleMs: null,
    dnd: false,
    provisional: false,
    tags: [],
  };
}

/** `live` with no presence means the socket is gone, which is what `detached` says. */
function historyState(lifecycle: AgentRecord["lifecycle"]): AgentState {
  return lifecycle === "live" ? "detached" : lifecycle;
}

function identity(name: string, claudeSessionId: string | null, registeredAt: number) {
  return claudeSessionId
    ? { id: claudeSessionId, idSource: "claudeSessionId" as const, name, claudeSessionId }
    : { id: `${name}@${registeredAt}`, idSource: "nameAtRegisteredAt" as const, name, claudeSessionId: null };
}

function spawnFacts(record: AgentRecord | undefined, input: RosterInput) {
  const name = record?.name;
  return {
    agentId: record?.agentId ?? null,
    origin: record === undefined ? ("unknown" as const) : record.adopted ? ("adopted" as const) : ("spawned" as const),
    spawnedBy: record?.spawnedBy ?? null,
    spawnedAt: record?.spawnedAt ?? null,
    surface: record?.meta["surface"] || null,
    profile: record?.meta["profile"] || null,
    seat: name === undefined ? null : seatOf(name, input.seatPrefixes ?? []),
  };
}

function costFacts(claudeSessionId: string | null, record: AgentRecord | undefined, input: RosterInput) {
  const priced = claudeSessionId ? input.costOf?.(claudeSessionId) : undefined;
  if (priced !== undefined) return { costUsd: priced, costSource: "session-analytics" as const };
  if (record?.exitCostUsd != null) return { costUsd: record.exitCostUsd, costSource: "exit-report" as const };
  return { costUsd: null, costSource: null };
}

export function seatOf(name: string, prefixes: readonly SeatPrefix[]): string | null {
  const matching = prefixes.filter(({ prefix }) => name.startsWith(`${prefix}-`));
  const best = matching.reduce<SeatPrefix | null>((top, seat) => (top && top.prefix.length >= seat.prefix.length ? top : seat), null);
  return best?.seat ?? null;
}

function taskIdOf(declared: Record<string, string> | undefined, workingOn: string | null): string | null {
  const stated = declared?.["task"] ?? declared?.["taskId"];
  if (stated) return stated;
  return TASK_ID.exec(workingOn ?? "")?.[0] ?? null;
}
