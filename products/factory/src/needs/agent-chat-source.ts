import type { OwnerAnswer, OwnerItem, QueueSource, ResolveResult } from "@titan-design/owner-queue";
import { queueResponseSchema, toOwnerItem, type QueueRow } from "./agent-chat-item.js";
import { pollTail } from "./poll-tail.js";
import { QueueReadError } from "./queue-read-error.js";

/** agent-chat's loopback auth header; the value is the 0600 `ui.token` and never leaves this process. */
export const TOKEN_HEADER = "X-Agent-Chat-Token";

export interface BrokerEndpoint {
  /** `http://127.0.0.1:<port>`, or null when no broker is running. Re-read on every call. */
  baseUrl: () => string | null;
  /** Re-read on every call, so a rotated token is picked up. */
  token: () => string | null;
  fetch?: typeof fetch;
  pollMs?: number;
}

const SOURCE = "agent-chat /api/queue";
const CLOSED_REASON = /is not an open item|no item with id/;

async function call(endpoint: BrokerEndpoint, path: string, init: RequestInit = {}): Promise<Response> {
  const baseUrl = endpoint.baseUrl();
  if (!baseUrl) throw new QueueReadError(SOURCE, "not-running", "no broker port to read (is the agent-chat broker running?)");
  const token = endpoint.token();
  if (!token) throw new QueueReadError(SOURCE, "unauthorized", "no ui.token to send");
  const headers = { ...(init.headers as Record<string, string>), [TOKEN_HEADER]: token };
  let res: Response;
  try {
    res = await (endpoint.fetch ?? fetch)(`${baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    throw new QueueReadError(SOURCE, "unreachable", `${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 401 || res.status === 403) throw new QueueReadError(SOURCE, "unauthorized", `${path} refused the token (${res.status})`);
  return res;
}

/** Every open row, raw; a failed, refused or malformed read throws a `QueueReadError`, never an empty list. */
export async function readBrokerQueue(endpoint: BrokerEndpoint): Promise<QueueRow[]> {
  const res = await call(endpoint, "/api/queue");
  if (!res.ok) throw new QueueReadError(SOURCE, "http", `/api/queue answered ${res.status}`);
  const parsed = queueResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new QueueReadError(SOURCE, "malformed", `/api/queue: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data.items;
}

/** A blank answer dismisses; anything else is the answer text. The broker arbitrates, so a second verdict loses. */
async function resolve(endpoint: BrokerEndpoint, msgId: string, answer: OwnerAnswer): Promise<ResolveResult> {
  const text = answer.text?.trim() || answer.optionId;
  const body = text ? { msgId, text, channel: "factory" } : { msgId };
  const res = await call(endpoint, text ? "/api/answer" : "/api/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string };
  if (res.ok && reply.ok === true) return { ok: true };
  const reason = reply.reason ?? reply.error ?? `answered ${res.status}`;
  return CLOSED_REASON.test(reason) ? { ok: false, reason: "closed" } : { ok: false, reason: "rejected", detail: reason };
}

/** The broker's human queue: questions, notices, messages, permission prompts and endorsements to the owner. */
export function agentChatSource(endpoint: BrokerEndpoint): QueueSource {
  const open = async (): Promise<OwnerItem[]> => (await readBrokerQueue(endpoint)).map(toOwnerItem);
  return {
    system: "agent-chat",
    open,
    tail: pollTail({ open, intervalMs: endpoint.pollMs }),
    resolve: (ref, answer) => resolve(endpoint, ref, answer),
  };
}
