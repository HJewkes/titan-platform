import type { NeedsList } from "../needs/merged.js";
import type { OwnerItem } from "@titan-design/owner-queue";
import type { FrictionDay } from "../shepherd/owner-friction.js";
import { waitingGates } from "../shepherd/waiting.js";
import type { WatchRow } from "../shepherd/view.js";
import { keysIn, prKey, refOfUrl, runKey } from "./keys.js";
import { subjectOf } from "../needs/overlap.js";
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
  queueAsks(): Ask[] | Promise<Ask[]>;
  /** The merged owner list (`titan-factory needs`). When set, it is the whole of "Needs you"; gates, seat queues and the agent-chat asks are not read for it. */
  needs?(): Promise<NeedsList>;
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

const WAITING_SHOWN = 5;
const FINISHED = new Set(["done", "cancelled", "failed"]);
const refOf = (row: WatchRow): string => (row.pr === null ? `${row.repo}@${row.branch}` : `${row.repo}#${row.pr}`);

/** A throwaway proof PR is registered only to exercise the gates; its runs never feed an owner round, though `shepherd status` still lists them. */
const proofFixtureRuns = (rows: readonly WatchRow[]): Set<string> => new Set(rows.filter((row) => row.ownerGateReason === "proof-fixture").map((row) => row.runId));

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
  const allRows = await guarded(gaps, "shepherd", [], () => sources.rows());
  const proofRuns = proofFixtureRuns(allRows);
  const rows = allRows.filter((row) => !proofRuns.has(row.runId));
  const gates = (await guarded(gaps, "factory gates", [], () => sources.gates())).filter((gate) => !proofRuns.has(gate.runId));
  const chat = await guarded<AgentChatDigest | undefined>(gaps, "agent-chat digest", undefined, () => sources.agentChat(windowMinutes));
  const queue = await guarded(gaps, "seat queues", [], () => sources.queueAsks());
  const seats = await guarded(gaps, "seat dispatch logs", [], () => sources.seatCosts(since));
  const needs = sources.needs ? await guarded(gaps, "owner queue", undefined, () => sources.needs!()) : undefined;
  gaps.push(...(needs?.gaps ?? []));
  const friction = await guarded(gaps, "owner friction", undefined, () => sources.friction?.(now));
  const waiting = waitingGates(rows, now).owner.slice(0, WAITING_SHOWN);
  return {
    slot,
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    needsYou: needs ? ownerAsks(needs.items.filter((item) => !proofRuns.has(runOfItem(item) ?? "")), rows, since) : [...gateAsks(gates, rows, since), ...queue, ...(chat ? chatAsks(chat) : [])],
    merged: [...shepherdMerged(rows, since), ...(chat?.mergedPrs ?? []).map((item) => ({ ref: refOfUrl(item.label), title: item.detail }))],
    stuck: [...shepherdStuck(rows, since), ...(chat ? chatStuck(chat) : [])],
    seats,
    spend: (chat?.spend ?? []).map((a) => ({ pool: a.account, sevenDay: a.now?.sevenDay, fiveHour: a.now?.fiveHour, stale: a.stale })),
    ...(waiting.length > 0 && { waiting }),
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

/** The digest's documented order: factory gates, then seat queues, then needs-decision tasks, then the broker. */
const SYSTEM_ORDER = ["hitl", "morning", "active-work", "agent-chat"];
/** An item merged from several systems sorts by the earliest, so a gate that a Morning line also names stays among the gates. */
const systemRank = (item: OwnerItem): number => {
  const ranks = item.sources.map((source) => SYSTEM_ORDER.indexOf(source.system)).filter((rank) => rank >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : SYSTEM_ORDER.length;
};

/** News (kind `know`) is not an ask. The sort is stable, so each system keeps the order its source read in. */
function ownerAsks(items: readonly OwnerItem[], rows: readonly WatchRow[], since: Date): Ask[] {
  return items
    .filter((item) => item.kind !== "know")
    .sort((a, b) => systemRank(a) - systemRank(b))
    .map((item) => ownerAsk(item, rows, since));
}

const runOfItem = (item: OwnerItem): string | undefined => item.keys.find((key) => key.startsWith("run:"))?.slice("run:".length);

/** A gate's line names its PR and step, from the Shepherd row for its run, and a gate open since before the window says so. */
function gateDetail(item: OwnerItem, rows: readonly WatchRow[], since: Date): Pick<Ask, "since"> & { prefix: string; keys: string[] } {
  const gateId = item.sources.find((source) => source.system === "hitl")!.ref;
  const runId = runOfItem(item);
  const row = rows.find((r) => r.runId === runId);
  const step = gateId.slice(gateId.indexOf("/") + 1).replace(/:\d+$/, "");
  return {
    prefix: `${row ? refOf(row) : (runId ?? gateId).slice(0, 8)} ${step}: `,
    keys: row?.pr != null ? [prKey(row.repo, row.pr)] : [],
    ...(Date.parse(item.openedAt) < since.getTime() && { since: item.openedAt }),
  };
}

/** Keys a digest compares by: PR and run refs loosened to repo and number, gate ids as they are. Task ids stay out, as the Morning asks leave them. */
function ownerAsk(item: OwnerItem, rows: readonly WatchRow[], since: Date): Ask {
  const gate = item.sources.some((source) => source.system === "hitl") ? gateDetail(item, rows, since) : undefined;
  const keys = [...item.keys.filter((key) => !key.startsWith("task:")).map((key) => subjectOf(key) ?? key), ...(gate?.keys ?? [])];
  return {
    text: `${gate?.prefix ?? ""}${item.summary}`,
    ...(item.command !== undefined && { command: item.command }),
    source: item.seat ?? item.sources[0]!.system,
    keys: [...new Set(keys)],
    ...(item.evidenceRef !== undefined && { evidence: item.evidenceRef }),
    ...(gate?.since !== undefined && { since: gate.since }),
  };
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
