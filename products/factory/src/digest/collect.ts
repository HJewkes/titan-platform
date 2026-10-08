import type { FrictionDay } from "../shepherd/owner-friction.js";
import type { WatchRow } from "../shepherd/view.js";
import { keysIn, prKey, refOfUrl, runKey } from "./keys.js";
import type { AgentChatDigest, Ask, DigestModel, DigestSlot, Merged, SeatLine, Stuck } from "./model.js";

export interface GateFact {
  runId: string;
  stepId: string;
  gateId: string;
  prompt: string;
  resolve: string;
  /** Absent on a gate opened before the brief migration; the ask falls back to `prompt`. */
  summary?: string;
  evidenceRef?: string;
  createdAt: string;
}

/** Where a digest's facts come from; tests pass fakes, the CLI passes the factory host and the agent-chat CLI. */
export interface DigestSources {
  rows(): Promise<WatchRow[]>;
  gates(): Promise<GateFact[]>;
  /** Throws when agent-chat is missing, slow, or too old to print JSON. */
  agentChat(windowMinutes: number): Promise<AgentChatDigest>;
  queueAsks(): Ask[];
  seatCosts(since: Date): SeatLine[];
  /** The owner-friction row for the day of `now`, or undefined when the store has none. Optional: a source that cannot read the gate store leaves the section out. */
  friction?(now: Date): FrictionDay | undefined;
}

export interface CollectOptions {
  sources: DigestSources;
  now: Date;
  windowMinutes: number;
  slot: DigestSlot;
}

const FINISHED = new Set(["done", "cancelled", "failed"]);
const refOf = (row: WatchRow): string => (row.pr === null ? `${row.repo}@${row.branch}` : `${row.repo}#${row.pr}`);

/** A source that fails becomes a gap line; the other sections still render. */
async function guarded<T>(gaps: string[], name: string, fallback: T, read: () => Promise<T> | T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    gaps.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return fallback;
  }
}

export async function collectDigest({ sources, now, windowMinutes, slot }: CollectOptions): Promise<DigestModel> {
  const gaps: string[] = [];
  const since = new Date(now.getTime() - windowMinutes * 60_000);
  const rows = await guarded(gaps, "shepherd", [], () => sources.rows());
  const gates = await guarded(gaps, "factory gates", [], () => sources.gates());
  const chat = await guarded<AgentChatDigest | undefined>(gaps, "agent-chat digest", undefined, () => sources.agentChat(windowMinutes));
  const queue = await guarded(gaps, "seat queues", [], () => sources.queueAsks());
  const seats = await guarded(gaps, "seat dispatch logs", [], () => sources.seatCosts(since));
  const friction = await guarded(gaps, "owner friction", undefined, () => sources.friction?.(now));
  return {
    slot,
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    needsYou: [...gateAsks(gates, rows, since), ...queue, ...(chat ? chatAsks(chat) : [])],
    merged: [...shepherdMerged(rows, since), ...(chat?.mergedPrs ?? []).map((item) => ({ ref: refOfUrl(item.label), title: item.detail }))],
    stuck: [...shepherdStuck(rows, since), ...(chat ? chatStuck(chat) : [])],
    seats,
    spend: (chat?.spend ?? []).map((a) => ({ pool: a.account, sevenDay: a.now?.sevenDay, fiveHour: a.now?.fiveHour, stale: a.stale })),
    ...(friction && { friction }),
    gaps: [...gaps, ...(chat?.gaps ?? []).map((gap) => `agent-chat: ${gap}`)],
  };
}

/** One ask per pending gate; a gate still pending from an earlier window repeats, marked with when it opened. */
function gateAsks(gates: readonly GateFact[], rows: readonly WatchRow[], since: Date): Ask[] {
  return gates.map((gate) => {
    const row = rows.find((r) => r.runId === gate.runId);
    const keys = [`gate:${gate.gateId}`, runKey(gate.runId), ...(row?.pr != null ? [prKey(row.repo, row.pr)] : [])];
    const text = `${row ? refOf(row) : gate.runId.slice(0, 8)} ${gate.stepId}: ${gate.summary ?? gate.prompt}`;
    return {
      text,
      command: gate.resolve,
      source: "factory",
      keys,
      ...(gate.evidenceRef !== undefined && { evidence: gate.evidenceRef }),
      ...(Date.parse(gate.createdAt) < since.getTime() && { since: gate.createdAt }),
    };
  });
}

function chatAsks(chat: AgentChatDigest): Ask[] {
  const named = (label: string, items: AgentChatDigest["readyToMerge"]): Ask[] =>
    items.map((item) => ({ text: `${label} ${refOfUrl(item.label)} ${item.detail}`.trim(), source: "agent-chat", keys: keysIn(item.label) }));
  const escalations = chat.ledger.escalations.map((e) => ({ text: `${e.from}: ${e.text}`, source: "agent-chat", keys: keysIn(e.text) }));
  return [...escalations, ...named("ready to merge:", chat.readyToMerge), ...named("needs a grant:", chat.needsGrant)];
}

const endedSince = (row: WatchRow, since: Date): boolean => row.phase === "done" && Date.parse(row.phaseSince) >= since.getTime();

function shepherdMerged(rows: readonly WatchRow[], since: Date): Merged[] {
  return rows.filter((row) => endedSince(row, since) && row.outcome?.kind === "merged").map((row) => ({ ref: refOf(row), title: row.task, at: row.phaseSince }));
}

/** Held or stalled live runs, plus runs that failed or stopped unmerged inside the window; older endings are history, not news. */
function shepherdStuck(rows: readonly WatchRow[], since: Date): Stuck[] {
  const live = rows
    .filter((row) => (row.held || row.stalled) && (!FINISHED.has(row.phase) || (row.phase === "failed" && Date.parse(row.phaseSince) >= since.getTime())))
    .map((row) => ({ ref: refOf(row), reason: row.held ? `held: ${row.held.reason}` : `${row.phase}: ${row.stalled!.reason}`, since: row.phaseSince }));
  const unmerged = rows
    .filter((row) => endedSince(row, since) && row.outcome?.kind !== "merged")
    .map((row) => ({ ref: refOf(row), reason: `stopped: ${row.outcome?.reason ?? "ended without a recorded outcome"}`, since: row.phaseSince }));
  return [...live, ...unmerged];
}

function chatStuck(chat: AgentChatDigest): Stuck[] {
  const claims = chat.stalled.map((c) => ({ ref: c.taskId, reason: `${c.agentId} stalled in ${c.phase}`, since: c.phaseAt }));
  const reports = chat.ledger.reports.map((r) => ({ ref: r.from, reason: r.line, since: new Date(r.at).toISOString() }));
  return [...claims, ...reports];
}
