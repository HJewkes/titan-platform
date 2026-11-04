import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { listAgents, type AgentRow } from "@titan-design/agent-dispatch";
import { priceRequest } from "@titan-design/session-analytics";
import { distinctRequests, extractTranscript, type TranscriptRequest } from "@titan-design/session-read";

export interface AgentChat {
  bin: string;
  timeoutMs: number;
  pollMs: number;
}

/** One dispatch's spend, in the shape `ImplementedSchema.usage` reads. */
interface DispatchUsage {
  usd: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  retries: number;
}

export interface AgentResult {
  row: AgentRow;
  final: unknown;
  usage: DispatchUsage;
}

export async function rosterRow(chat: AgentChat, name: string): Promise<AgentRow | undefined> {
  return (await listAgents(chat.bin, chat.timeoutMs)).find((row) => row.name === name);
}

/** A resumed session appends to its transcript, so only bytes past this offset belong to the new turn. */
export function transcriptEnd(row: AgentRow | undefined): { path?: string; offset: number } {
  const path = row?.transcriptPath ?? undefined;
  if (!path) return { offset: 0 };
  try {
    return { path, offset: statSync(path).size };
  } catch {
    return { path, offset: 0 };
  }
}

/** Polls the roster until `name` has exited. */
async function awaitExit(chat: AgentChat, name: string, signal: AbortSignal): Promise<AgentRow> {
  for (;;) {
    signal.throwIfAborted();
    const row = await rosterRow(chat, name);
    if (row?.presence === "exited") return row;
    await sleep(chat.pollMs, undefined, { signal });
  }
}

/** The last fenced JSON block of the final assistant message, or the whole message when it has none. */
function lastJsonBlock(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const body = (fenced ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`[final-message] the agent's last message is not JSON: ${body.slice(0, 120)}`);
  }
}

interface AgentTurn {
  row: AgentRow;
  /** The final assistant message, whole: an answer longer than the index's span cap would lose its closing fence. */
  text: string | undefined;
  usage: DispatchUsage;
}

/** Waits for the agent to exit, then reads its final message and sums every request it made past `from`. */
export async function awaitTurn(chat: AgentChat, name: string, signal: AbortSignal, from: { path?: string; offset: number } = { offset: 0 }): Promise<AgentTurn> {
  const row = await awaitExit(chat, name, signal);
  if (!row.transcriptPath) throw new Error(`[no-transcript] ${name} exited with no transcript`);
  const fromByteOffset = from.path === row.transcriptPath ? from.offset : 0;
  const delta = await extractTranscript(row.transcriptPath, { fromByteOffset, spanTextCap: Infinity });
  const text = delta.spans.filter((span) => span.field === "assistant_response").at(-1)?.text;
  return { row, text, usage: sumUsage(delta.requests) };
}

/** The final message must exist and parse; `name` names the agent in the error. */
export function finalOf(name: string, text: string | undefined): unknown {
  if (text === undefined) throw new Error(`[final-message] ${name} exited without an assistant message`);
  return lastJsonBlock(text);
}

export async function awaitAgent(chat: AgentChat, name: string, signal: AbortSignal, from?: { path?: string; offset: number }): Promise<AgentResult> {
  const turn = await awaitTurn(chat, name, signal, from);
  return { row: turn.row, final: finalOf(name, turn.text), usage: turn.usage };
}

function sumUsage(requests: readonly TranscriptRequest[]): DispatchUsage {
  const total: DispatchUsage = { usd: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, retries: 0 };
  for (const request of distinctRequests(requests)) {
    total.usd += priceRequest(request, request.model, request.ts).costUsd;
    total.cacheReadTokens += request.cacheReadTokens;
    total.cacheWrite5mTokens += request.cacheCreation5mTokens;
    total.cacheWrite1hTokens += request.cacheCreation1hTokens;
  }
  return total;
}

/** True once the agent's transcript holds its first assistant event, or it has already exited. */
export async function hasResponded(chat: AgentChat, name: string): Promise<boolean> {
  const row = await rosterRow(chat, name);
  if (row === undefined) return false;
  if (row.presence === "exited") return true;
  if (!row.transcriptPath) return false;
  try {
    return (await extractTranscript(row.transcriptPath)).requests.length > 0;
  } catch {
    return false;
  }
}
