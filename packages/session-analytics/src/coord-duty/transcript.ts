import { isRecord } from "@titan-design/rpc-protocol/narrow";

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

/** One assistant message id. A streamed message spans several records; the last usage seen wins. */
export interface TranscriptCall {
  id: string;
  ts: string;
  model: string;
  usage: Record<string, unknown> | null;
  tools: ToolUse[];
}

/** From one user record with prompt text up to the next; every call after its start belongs to it. */
export interface TranscriptTurn {
  ts: string;
  /** The first TURN_TEXT_CHARS of the prompt, enough for the trigger rules and the report head. */
  text: string;
  origin: string | null;
  callIds: string[];
  /** Every tool use in the turn, including calls a later dedupe or window cut drops: the outcome reads them all. */
  tools: ToolUse[];
}

export interface SeatTranscript {
  turns: TranscriptTurn[];
  calls: Map<string, TranscriptCall>;
}

const TURN_TEXT_CHARS = 400;
const SYNTHETIC_MODEL = "<synthetic>";

type JsonRecord = Record<string, unknown>;

export function parseSeatTranscript(lines: Iterable<string>): SeatTranscript {
  const turns: TranscriptTurn[] = [];
  const calls = new Map<string, TranscriptCall>();
  let current: TranscriptTurn | null = null;
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record || record.isSidechain) continue;
    if (record.type === "user") {
      const turn = turnStart(record);
      if (turn) turns.push((current = turn));
    } else if (record.type === "assistant" && current) {
      addAssistantRecord(record, current, calls);
    }
  }
  return { turns, calls };
}

function turnStart(record: JsonRecord): TranscriptTurn | null {
  const text = promptText(messageOf(record).content);
  if (text === null) return null;
  const origin = typeof record.turnOrigin === "string" ? record.turnOrigin : null;
  return { ts: stringField(record, "timestamp"), text: text.slice(0, TURN_TEXT_CHARS), origin, callIds: [], tools: [] };
}

function addAssistantRecord(record: JsonRecord, turn: TranscriptTurn, calls: Map<string, TranscriptCall>): void {
  const message = messageOf(record);
  const tools = toolUses(message.content);
  turn.tools.push(...tools);
  if (typeof message.id !== "string") return;
  let call = calls.get(message.id);
  if (!call) {
    call = { id: message.id, ts: stringField(record, "timestamp"), model: stringField(message, "model"), usage: null, tools: [] };
    calls.set(message.id, call);
    turn.callIds.push(message.id);
  }
  if (isRecord(message.usage) && message.model !== SYNTHETIC_MODEL) call.usage = message.usage;
  call.tools.push(...tools);
}

/** Prompt text of a user record, or null for a tool result or an empty prompt. */
function promptText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter(isRecord);
  if (blocks.some((block) => block.type === "tool_result")) return null;
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => stringField(block, "text"))
    .join(" ");
  return text.trim() ? text : null;
}

function toolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isRecord)
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ name: stringField(block, "name"), input: isRecord(block.input) ? block.input : {} }));
}

/** Records scanned for a seat marker, as find_seats.py does: a seat boots and registers early. */
const SEAT_SCAN_RECORDS = 400;
const SEAT_PROMPT_CHARS = 3_000;

/**
 * The seat a transcript belongs to: the first user prompt saying `as seat <seat>`, or the first
 * `chat_register` call naming a seat. A sidechain record ends the scan, since a subagent file is no seat.
 */
export function seatOf(lines: Iterable<string>, seats: readonly string[]): string | null {
  const bootPrompt = new RegExp(`as seat (${seats.map(escapeRegExp).join("|")})(?![\\w-])`);
  let index = 0;
  for (const line of lines) {
    if (index++ > SEAT_SCAN_RECORDS) break;
    if (!seats.some((seat) => line.includes(seat))) continue;
    const record = parseRecord(line);
    if (!record) continue;
    if (record.isSidechain) return null;
    const seat = record.type === "user" ? bootPrompt.exec(seatPromptText(record))?.[1] : registeredSeat(record, seats);
    if (seat) return seat;
  }
  return null;
}

function seatPromptText(record: JsonRecord): string {
  const content = messageOf(record).content;
  if (typeof content === "string") return content.slice(0, SEAT_PROMPT_CHARS);
  if (!Array.isArray(content)) return "";
  const blocks = content.filter(isRecord).filter((block) => block.type === "text");
  return blocks.map((block) => stringField(block, "text")).join(" ").slice(0, SEAT_PROMPT_CHARS);
}

function registeredSeat(record: JsonRecord, seats: readonly string[]): string | undefined {
  if (record.type !== "assistant") return undefined;
  const register = toolUses(messageOf(record).content).find((tool) => tool.name.endsWith("chat_register"));
  const name = register?.input.name;
  return typeof name === "string" && seats.includes(name) ? name : undefined;
}

function parseRecord(line: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function messageOf(record: JsonRecord): JsonRecord {
  return isRecord(record.message) ? record.message : {};
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
