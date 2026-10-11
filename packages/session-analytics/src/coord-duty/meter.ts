import { priceRequest, type RequestTokens } from "../price-request.js";
import { PRICE_TABLE, type PriceRow } from "../prices.js";
import { assignTurn, OTHER_TOOL, type InheritMode } from "./assign.js";
import { toolDuty, type DutyRuleSet, type RuleContext } from "./rules.js";
import { parseSeatTranscript, type TranscriptCall, type TranscriptTurn } from "./transcript.js";
import { outcomeOf, triggerOf, type Outcome, type Trigger } from "./turn-signals.js";

/** One file of a seat session. A session can have several copies: two profiles, or a mirror. */
export interface TranscriptCopy {
  seat: string;
  sessionId: string;
  /** Orders the copies of a session, largest first. */
  size: number;
  /** Window start for this copy's pool; the pools moved accounts at different times. */
  lo: string;
  lines: Iterable<string>;
}

export type CacheWriteTtl = "5m" | "1h";

/**
 * Owner decision D2: a cache write with no 5m/1h split prices at the 5m rate, as `priceRequest`
 * does. agent_usage.py, which TP-1550 priced with, used 1h; pass `splitlessCacheWrite: "1h"` for its delta.
 */
export const SPLITLESS_CACHE_WRITE_TTL: CacheWriteTtl = "5m";

export interface MeterOptions {
  /** Window end, exclusive. */
  hi: string;
  rules: DutyRuleSet;
  inherit: InheritMode;
  /** Operator sessions: their channel messages and pane text are relays. */
  ops: readonly string[];
  /** Recipient prefixes counted as owner communication. */
  owners: readonly string[];
  splitlessCacheWrite?: CacheWriteTtl;
  prices?: readonly PriceRow[];
}

export interface DutyCall {
  seat: string;
  /** The 8-char session prefix. */
  sid: string;
  ts: string;
  usd: number;
  duty: string;
  raw: string | null;
  trig: Trigger;
  outcome: Outcome;
  /** The start of the call's turn. */
  turn: string;
  /** The first tool's command, or `<tool> <json input>`. */
  ex: string;
}

export interface DutyTurn {
  seat: string;
  ts: string;
  trig: Trigger;
  outcome: Outcome;
  usd: number;
  calls: number;
  head: string;
}

export interface MeterInputs {
  transcripts: number;
  sessions: number;
  /** Copies past the first of a session. */
  dupCopies: number;
  /** Calls whose model has no price row, costed at 0 and counted here so the gap is visible. */
  unpriced: number;
  unpricedModels: Record<string, number>;
  /** Calls with a cache write but no 5m/1h split, priced at the splitless rate. */
  splitlessCacheWrites: number;
}

export interface MeterResult {
  calls: DutyCall[];
  turns: DutyTurn[];
  inputs: MeterInputs;
}

/**
 * Meters seat transcripts. Copies of a session run largest first, and a message id is priced
 * only the first time it is seen, so a smaller copy adds only what the larger one lacks; it is
 * never taken for a prefix. A turn counts only if it holds a newly priced call.
 */
export function mergeCopies(copies: readonly TranscriptCopy[], options: MeterOptions): MeterResult {
  const state: MeterState = { seen: new Set(), calls: [], turns: [], inputs: emptyInputs(), options, hiMs: parseInstant(options.hi) };
  const sessions = groupBySession(copies);
  state.inputs.transcripts = copies.length;
  state.inputs.sessions = sessions.length;
  state.inputs.dupCopies = copies.length - sessions.length;
  for (const session of sessions) {
    for (const copy of [...session].sort((a, b) => b.size - a.size)) meterCopy(copy, state);
  }
  return { calls: state.calls, turns: state.turns, inputs: state.inputs };
}

interface MeterState {
  seen: Set<string>;
  calls: DutyCall[];
  turns: DutyTurn[];
  inputs: MeterInputs;
  options: MeterOptions;
  hiMs: number;
}

function meterCopy(copy: TranscriptCopy, state: MeterState): void {
  const transcript = parseSeatTranscript(copy.lines);
  const loMs = parseInstant(copy.lo);
  for (const turn of transcript.turns) {
    const fresh = turn.callIds
      .map((id) => transcript.calls.get(id))
      .filter((call): call is TranscriptCall => call !== undefined && call.usage !== null && !state.seen.has(call.id) && inWindow(call.ts, loMs, state.hiMs));
    if (fresh.length === 0) continue;
    for (const call of fresh) state.seen.add(call.id);
    meterTurn(copy, turn, fresh, state);
  }
}

function meterTurn(copy: TranscriptCopy, turn: TranscriptTurn, fresh: TranscriptCall[], state: MeterState): void {
  const { rules, inherit, ops } = state.options;
  const trig = triggerOf(turn.text, turn.origin, ops);
  const outcome = outcomeOf(turn.tools);
  const rows = fresh.map((call) => callRow(copy, turn, call, { trig, outcome }, state));
  assignTurn(rows, trig, outcome, rules, inherit);
  state.calls.push(...rows);
  const usd = rows.reduce((sum, row) => sum + row.usd, 0);
  state.turns.push({ seat: copy.seat, ts: turn.ts, trig, outcome, usd, calls: rows.length, head: turn.text.slice(0, HEAD_CHARS) });
}

const HEAD_CHARS = 200;
const EXAMPLE_CHARS = 300;
const EXAMPLE_INPUT_CHARS = 200;
const SID_CHARS = 8;

function callRow(copy: TranscriptCopy, turn: TranscriptTurn, call: TranscriptCall, signals: { trig: Trigger; outcome: Outcome }, state: MeterState): DutyCall {
  const context: RuleContext = { owners: state.options.owners };
  const duties = call.tools.map((tool) => toolDuty(tool, state.options.rules, context)).filter((duty) => duty !== null);
  const raw = duties[0] ?? (call.tools.length > 0 ? OTHER_TOOL : null);
  const usd = priceCall(call, state);
  return { seat: copy.seat, sid: copy.sessionId.slice(0, SID_CHARS), ts: call.ts, usd, duty: "", raw, ...signals, turn: turn.ts, ex: example(call) };
}

function example(call: TranscriptCall): string {
  const first = call.tools[0];
  if (!first) return "";
  const command = first.input.command;
  if (first.name === "Bash") return typeof command === "string" ? command.slice(0, EXAMPLE_CHARS) : "";
  return `${first.name.split("__").at(-1) ?? first.name} ${JSON.stringify(first.input).slice(0, EXAMPLE_INPUT_CHARS)}`;
}

function priceCall(call: TranscriptCall, state: MeterState): number {
  const { tokens, splitless } = requestTokens(call.usage ?? {}, state.options.splitlessCacheWrite ?? SPLITLESS_CACHE_WRITE_TTL);
  if (splitless) state.inputs.splitlessCacheWrites++;
  const priced = priceRequest(tokens, call.model, call.ts, state.options.prices ?? PRICE_TABLE);
  if (!priced.priced) {
    state.inputs.unpriced++;
    state.inputs.unpricedModels[call.model] = (state.inputs.unpricedModels[call.model] ?? 0) + 1;
  }
  return priced.costUsd;
}

function requestTokens(usage: Record<string, unknown>, splitlessTtl: CacheWriteTtl): { tokens: RequestTokens; splitless: boolean } {
  const split = asRecord(usage.cache_creation);
  const write5m = count(split.ephemeral_5m_input_tokens);
  const write1h = count(split.ephemeral_1h_input_tokens);
  const total = count(usage.cache_creation_input_tokens);
  const splitless = total > 0 && write5m === 0 && write1h === 0;
  const tokens: RequestTokens = {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheCreation5mTokens: splitless && splitlessTtl === "5m" ? total : write5m,
    cacheCreation1hTokens: splitless && splitlessTtl === "1h" ? total : write1h,
  };
  return { tokens, splitless };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function groupBySession(copies: readonly TranscriptCopy[]): TranscriptCopy[][] {
  const bySession = new Map<string, TranscriptCopy[]>();
  for (const copy of copies) {
    const session = bySession.get(copy.sessionId);
    if (session) session.push(copy);
    else bySession.set(copy.sessionId, [copy]);
  }
  return [...bySession.values()];
}

function emptyInputs(): MeterInputs {
  return { transcripts: 0, sessions: 0, dupCopies: 0, unpriced: 0, unpricedModels: {}, splitlessCacheWrites: 0 };
}

/** A call is in the window when `lo <= ts < hi`; instants compare as times, not strings, so `...T18:00Z` and `...T18:00:00.000Z` agree. */
function inWindow(ts: string, loMs: number, hiMs: number): boolean {
  const at = Date.parse(ts);
  return at >= loMs && at < hiMs;
}

/** A bound with no offset is UTC, as the method's window constants are; Date.parse would read it as local time. */
export function parseInstant(iso: string): number {
  const ms = Date.parse(/[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso) ? `${iso}Z` : iso);
  if (Number.isNaN(ms)) throw new Error(`coord-duty: not an ISO instant: ${iso}`);
  return ms;
}
