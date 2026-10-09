import { z } from "zod";
import {
  agentGraph,
  agentRosterSnapshot,
  foldAgentGraph,
  foldRoster,
  historyWindow,
  historyWindowOf,
  type BrokerEvent,
  type SeatPrefix,
} from "@titan-design/chat-protocol/agents";
import { defineCommand } from "@titan-design/registry";
import { BROKER_HISTORY_LIMIT, MESSAGE_KINDS, readMessageRows, type BrokerReader, type BrokerSnapshot, type EventRow, type MessageQuery } from "./broker.js";

export interface AgentsSource {
  broker: BrokerReader;
  /** agent-chat's events.db, opened read-only per call; when it will not open, agents.messages falls back to the broker's history window. */
  eventsDbPath: string;
  seatPrefixes: readonly SeatPrefix[];
  now?: () => number;
}

const DEFAULT_PAGE = 200;

const agentMessage = z.object({
  /** The events.db row id, the paging cursor; null on the history fallback, which carries none. */
  id: z.number().int().nullable(),
  msgId: z.string(),
  kind: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  text: z.string(),
  at: z.number(),
  /** The msgId an answer or decision closes. */
  ref: z.string().nullable(),
  meta: z.record(z.string(), z.string()),
});
type AgentMessage = z.infer<typeof agentMessage>;

const agentMessages = z.object({
  messages: z.array(agentMessage),
  source: z.enum(["events-db", "history"]),
  /** True on the history fallback: older messages exist that this read cannot reach. */
  partial: z.boolean(),
  /** Pass as `before` for the next older page; null when there is none or on the fallback. */
  nextCursor: z.number().int().nullable(),
  /** The broker window the fallback filtered; null when events.db answered. */
  history: historyWindow.nullable(),
});
type AgentMessages = z.infer<typeof agentMessages>;

const messagesArgs = z.object({
  agent: z.string().min(1).describe("The agent-chat agent name whose sent and received messages to list"),
  peer: z.string().min(1).optional().describe("Only messages between agent and this peer"),
  before: z.number().int().positive().optional().describe("Id cursor: only messages older than this events.db row, from nextCursor"),
  limit: z.number().int().positive().max(BROKER_HISTORY_LIMIT).default(DEFAULT_PAGE),
});

/** Queue kinds a person answers, in the order the queue shows them. */
const QUEUE_ORDER = ["question", "endorse_request", "approval_request", "message", "notice"];

const queueItem = z.object({
  msgId: z.string(),
  kind: z.string(),
  asker: z.string(),
  text: z.string(),
  at: z.number(),
  ageMs: z.number(),
  options: z.array(z.string()).nullable(),
  recommended: z.string().nullable(),
  meta: z.record(z.string(), z.string()),
});
type QueueItem = z.infer<typeof queueItem>;

const agentQueue = z.object({
  items: z.array(queueItem),
  /** Broker-generated items left out, keyed by `kind` or `kind:event`. */
  hidden: z.record(z.string(), z.number().int()),
  open: z.number().int(),
  generatedAt: z.number(),
});
type AgentQueue = z.infer<typeof agentQueue>;

/** Every command reads the broker or events.db; none writes to either. */
export function agentsCommands(source: AgentsSource) {
  const now = source.now ?? Date.now;
  const roster = (snapshot: BrokerSnapshot, at: number) =>
    foldRoster({ ...snapshot, historyLimit: BROKER_HISTORY_LIMIT, now: at, seatPrefixes: source.seatPrefixes });
  return {
    "agents.roster": defineCommand({
      name: "agents.roster",
      description: "Every agent the agent-chat broker knows: live presence, then exited and retired agents from its history",
      args: z.object({}),
      result: agentRosterSnapshot,
      run: async () => roster(await source.broker.read(), now()),
    }),
    "agents.graph": defineCommand({
      name: "agents.graph",
      description: "The agent spawn tree with spawned-by and message edges, counted over the broker's history window",
      args: z.object({}),
      result: agentGraph,
      run: async () => {
        const snapshot = await source.broker.read();
        const at = now();
        return foldAgentGraph({ events: snapshot.events, historyLimit: BROKER_HISTORY_LIMIT, now: at, roster: roster(snapshot, at).agents });
      },
    }),
    ...conversationCommands(source, now),
  };
}

function conversationCommands(source: AgentsSource, now: () => number) {
  return {
    "agents.messages": defineCommand({
      name: "agents.messages",
      description: "An agent's messages, or a pair's, newest first and paged by id from events.db; the broker's history window when events.db will not open",
      args: messagesArgs,
      result: agentMessages,
      run: (query) => readMessages(source, query),
    }),
    "agents.queue": defineCommand({
      name: "agents.queue",
      description: "Open items waiting on the human, questions first, with asker and age; broker-generated notices are counted, not listed",
      args: z.object({ include_system: z.boolean().optional().describe("List the broker's own exit and lifecycle notices too") }),
      result: agentQueue,
      run: async ({ include_system }) => foldQueue(await source.broker.queue(), now(), include_system ?? false),
    }),
  };
}

async function readMessages(source: AgentsSource, query: MessageQuery): Promise<AgentMessages> {
  // One extra row says whether an older page exists.
  const rows = readMessageRows(source.eventsDbPath, { ...query, limit: query.limit + 1 });
  if (rows) {
    const page = rows.slice(0, query.limit).map(fromRow);
    const nextCursor = rows.length > query.limit ? page[page.length - 1]!.id : null;
    return { messages: page, source: "events-db", partial: false, nextCursor, history: null };
  }
  const events = await source.broker.history();
  // History has no ids, so no page past the first can be placed in it.
  const messages = query.before === undefined ? events.filter(inConversation(query)).sort((a, b) => b.at - a.at).slice(0, query.limit).map(fromEvent) : [];
  return { messages, source: "history", partial: true, nextCursor: null, history: historyWindowOf(events, BROKER_HISTORY_LIMIT) };
}

function inConversation({ agent, peer }: MessageQuery): (event: BrokerEvent) => boolean {
  const kinds: readonly string[] = MESSAGE_KINDS;
  return (event) => {
    const to = event.meta["target"];
    const party = peer === undefined ? event.from === agent || to === agent : (event.from === agent && to === peer) || (event.from === peer && to === agent);
    return party && kinds.includes(event.kind);
  };
}

function fromRow(row: EventRow): AgentMessage {
  const id = String(row.id);
  return { id: row.id, msgId: row.msg_id ?? id, kind: row.kind, from: row.actor, to: row.target, text: row.body ?? "", at: row.ts, ref: row.ref, meta: parseMeta(row.meta) };
}

function fromEvent(event: BrokerEvent): AgentMessage {
  return { id: null, msgId: event.msgId, kind: event.kind, from: event.from, to: event.meta["target"] ?? null, text: event.text, at: event.at, ref: event.meta["ref"] ?? null, meta: event.meta };
}

/** agent-chat writes meta as a JSON object of strings; anything else in the column is dropped rather than trusted. */
function parseMeta(raw: string | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** The broker files its own exit and lifecycle notices to the human; nearly the whole queue is these. */
const isSystem = (event: BrokerEvent): boolean => event.from === "agent-chat" || event.meta["event"] !== undefined;

function foldQueue(events: readonly BrokerEvent[], at: number, includeSystem: boolean): AgentQueue {
  const hidden: Record<string, number> = {};
  const shown = events.filter((event) => {
    if (includeSystem || !isSystem(event)) return true;
    const key = event.meta["event"] === undefined ? event.kind : `${event.kind}:${event.meta["event"]}`;
    hidden[key] = (hidden[key] ?? 0) + 1;
    return false;
  });
  const items = shown.sort((a, b) => queueRank(a) - queueRank(b) || a.at - b.at).map((event) => toQueueItem(event, at));
  return { items, hidden, open: events.length, generatedAt: at };
}

function queueRank(event: BrokerEvent): number {
  const rank = QUEUE_ORDER.indexOf(event.kind);
  return rank === -1 ? QUEUE_ORDER.length : rank;
}

function toQueueItem(event: BrokerEvent, at: number): QueueItem {
  const { msgId, kind, from, text, meta } = event;
  return { msgId, kind, asker: from, text, at: event.at, ageMs: Math.max(0, at - event.at), options: parseOptions(meta["options"]), recommended: meta["recommended"] ?? null, meta };
}

/** Meta values are strings, so a question's options arrive as a JSON-encoded array. */
function parseOptions(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}
