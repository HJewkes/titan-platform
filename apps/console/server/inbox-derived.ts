/**
 * Machine-derived inbox rows: exceptions the console reads off Shepherd and the agent roster, where no producer filed
 * anything. No evidence, no exception: every row names what was observed, by which source and when, and the threshold
 * it crossed, and {@link derivedRow} refuses a row without them. The rows carry no action, and they sit beside
 * `inbox.list`'s items rather than among them, so `inbox.act` can never find one to act on.
 */
import type { AgentRosterEntry, AgentRosterSnapshot } from "@titan-design/chat-protocol/agents";
import type { ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const MINUTE = 60_000;

/**
 * Shepherd's shortest phase stall limit (merging), mirrored because the console cannot depend on titan-factory. Every
 * phase-overstay verdict clears it; a stall verdict on a younger phase waits until it does.
 */
export const STALLED_RUN_AFTER_MS = 15 * MINUTE;
/** A failed run cannot recover on its own, so it is an exception from the moment Shepherd reports it. */
const FAILED_RUN_AFTER_MS = 0;
/** Shepherd keeps a failed run in its finished list for good; the inbox shows one for a day, the owner's daily look. */
export const FAILED_RUN_LOOKBACK_MS = 24 * 60 * MINUTE;
/** An agent blocked on a prompt for a quarter hour is past the time an operator normally takes to answer one. */
export const BLOCKED_AGENT_AFTER_MS = 15 * MINUTE;

type DerivedKind = "stalled-run" | "failed-run" | "blocked-agent";

interface DerivedEvidence {
  /** What the source reported, in its own words where it has them. */
  observed: string;
  /** Which reader saw it: a Shepherd row or the broker's presence. */
  source: string;
  /** When the observed state began, ISO 8601. */
  at: string;
}

interface CrossedThreshold {
  name: string;
  limitMs: number;
  /** How far past `evidence.at` the read was taken. */
  ageMs: number;
}

/** A read-only "go look" row: a link to where the exception lives, and no action. */
export interface DerivedRow {
  id: string;
  kind: DerivedKind;
  summary: string;
  evidence: DerivedEvidence;
  threshold: CrossedThreshold;
  link: string;
}

export interface DerivedInput {
  id: string;
  kind: DerivedKind;
  summary: string;
  evidence: Partial<DerivedEvidence> | undefined;
  threshold: Omit<CrossedThreshold, "ageMs">;
  link: string;
}

export class DerivedRowRefusedError extends Error {
  override name = "DerivedRowRefusedError";
}

function checkedEvidence(id: string, evidence: Partial<DerivedEvidence> | undefined): DerivedEvidence {
  const { observed, source, at } = evidence ?? {};
  if (!observed || !source || !at) throw new DerivedRowRefusedError(`derived row ${id} names no evidence: it needs what was observed, by which source and when`);
  if (Number.isNaN(Date.parse(at))) throw new DerivedRowRefusedError(`derived row ${id}'s evidence time ${at} is not a time`);
  return { observed, source, at };
}

/** The one constructor for a derived row; a row whose evidence is missing or partial is refused, never shown. */
export function derivedRow(input: DerivedInput, now: number): DerivedRow {
  const evidence = checkedEvidence(input.id, input.evidence);
  const threshold = { ...input.threshold, ageMs: Math.max(0, now - Date.parse(evidence.at)) };
  return { id: input.id, kind: input.kind, summary: input.summary, evidence, threshold, link: input.link };
}

const minutes = (ms: number): string => `${Math.floor(ms / MINUTE)} min`;
const ageOf = (at: string, now: number): number => now - Date.parse(at);
const target = (row: WatchRow): string => (row.pr === null ? `${row.repo} run ${row.runId}` : `${row.repo}#${row.pr}`);
const timelineLink = (row: WatchRow): string => (row.pr === null ? "#/shepherd" : `#/shepherd/${encodeURIComponent(`${row.repo}#${row.pr}`)}`);

function stalledRunRow(row: WatchRow, now: number): DerivedRow {
  return derivedRow(
    {
      id: `derived:stalled-run:${row.runId}`,
      kind: "stalled-run",
      summary: `${target(row)} is stalled in ${row.phase}`,
      evidence: row.stalled === null ? undefined : { observed: `stalled: ${row.stalled.reason}`, source: `shepherd row ${row.runId}`, at: row.phaseSince },
      threshold: { name: `Shepherd stall verdict, phase older than ${minutes(STALLED_RUN_AFTER_MS)}`, limitMs: STALLED_RUN_AFTER_MS },
      link: timelineLink(row),
    },
    now,
  );
}

function failedRunRow(row: WatchRow, now: number): DerivedRow {
  return derivedRow(
    {
      id: `derived:failed-run:${row.runId}`,
      kind: "failed-run",
      summary: `${target(row)}'s run failed`,
      evidence: { observed: `phase failed: ${row.stalled?.reason ?? "the run recorded no error"}`, source: `shepherd row ${row.runId}`, at: row.phaseSince },
      threshold: { name: "a failed run", limitMs: FAILED_RUN_AFTER_MS },
      link: timelineLink(row),
    },
    now,
  );
}

/** Live runs Shepherd has given a stall verdict, once their phase is past the stall threshold. */
export function stalledRunRows(active: readonly WatchRow[], now: number): DerivedRow[] {
  return active.filter((row) => row.stalled !== null && ageOf(row.phaseSince, now) > STALLED_RUN_AFTER_MS).map((row) => stalledRunRow(row, now));
}

/** Runs that failed inside the lookback, except where the same PR already has a live run again. */
export function failedRunRows(finished: readonly WatchRow[], active: readonly WatchRow[], now: number): DerivedRow[] {
  const live = new Set(active.map(target));
  return finished
    .filter((row) => row.phase === "failed" && !live.has(target(row)))
    .filter((row) => ageOf(row.phaseSince, now) >= FAILED_RUN_AFTER_MS && ageOf(row.phaseSince, now) <= FAILED_RUN_LOOKBACK_MS)
    .map((row) => failedRunRow(row, now));
}

function blockedAgentRow(agent: AgentRosterEntry, idleMs: number, now: number): DerivedRow {
  return derivedRow(
    {
      id: `derived:blocked-agent:${agent.id}`,
      kind: "blocked-agent",
      summary: `${agent.name} is blocked`,
      evidence: { observed: `presence blocked, silent for ${minutes(idleMs)}`, source: "agent-chat presence", at: new Date(now - idleMs).toISOString() },
      threshold: { name: `blocked longer than ${minutes(BLOCKED_AGENT_AFTER_MS)}`, limitMs: BLOCKED_AGENT_AFTER_MS },
      link: `#/agents/${encodeURIComponent(agent.name)}`,
    },
    now,
  );
}

/**
 * Agents the broker's live presence calls blocked for longer than the threshold. Presence carries no blocked-since, so
 * the age is the time since the agent last spoke, which an agent waiting on a prompt does not do.
 */
export function blockedAgentRows(roster: AgentRosterSnapshot): DerivedRow[] {
  return roster.agents.flatMap((agent) =>
    agent.state === "blocked" && agent.stateSource === "presence" && agent.idleMs !== null && agent.idleMs > BLOCKED_AGENT_AFTER_MS ? [blockedAgentRow(agent, agent.idleMs, roster.generatedAt)] : [],
  );
}

/** Oldest exception first, since it has waited longest; the id breaks a tie so a poll never reshuffles. */
export function byDerivedOrder(a: DerivedRow, b: DerivedRow): number {
  const age = b.threshold.ageMs - a.threshold.ageMs;
  return age !== 0 ? age : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
