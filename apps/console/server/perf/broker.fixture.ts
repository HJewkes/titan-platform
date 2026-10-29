// A synthetic agent-chat broker at the size the console's audit measured (TP-4403 §3d): 60 agents and 5,000 messages.
import type { BrokerEvent, BrokerSession } from "@titan-design/chat-protocol/agents";
import { BROKER_HISTORY_LIMIT, MESSAGE_KINDS } from "../broker.js";
import { draw, FIXTURE_EPOCH_MS, pad, WORDS } from "./random.fixture.js";

export const BROKER_SIZES = { agents: 60, messages: 5000, queue: 40 } as const;

const PRESENCE = ["working", "available", "blocked"] as const;
const MINUTE_MS = 60_000;

/** One conversation row, as agent-chat's events table holds it and as `/api/history` serves it. */
export interface BrokerMessage {
  id: number;
  ts: number;
  kind: (typeof MESSAGE_KINDS)[number];
  actor: string;
  target: string;
  msgId: string;
  body: string;
}

export interface BrokerState {
  sessions: BrokerSession[];
  /** Oldest first, as the events table's ids run. */
  messages: BrokerMessage[];
}

const agentName = (index: number): string => `${WORDS[index % WORDS.length]}-agent-${pad(index, 2)}`;

export function brokerState(seed: string): BrokerState {
  const random = draw(`${seed}:broker`);
  const names = Array.from({ length: BROKER_SIZES.agents }, (_, index) => agentName(index));
  const sessions = names.map((name, index) => ({
    name,
    workingOn: `synthetic work item ${index}`,
    cwd: `/synthetic/worktrees/${name}`,
    status: random.pick(PRESENCE),
    idleMs: random.int(3_600_000),
    registeredAt: FIXTURE_EPOCH_MS - random.int(86_400_000),
  }));
  const messages = Array.from({ length: BROKER_SIZES.messages }, (_, index) => ({
    id: index + 1,
    ts: FIXTURE_EPOCH_MS - (BROKER_SIZES.messages - index) * MINUTE_MS,
    kind: random.pick(MESSAGE_KINDS),
    actor: random.pick(names),
    target: random.chance(0.05) ? "human" : random.pick(names),
    msgId: `msg-${pad(index + 1, 5)}`,
    body: `Synthetic message ${index + 1}: ${"status update ".repeat(1 + random.int(10)).trim()}`,
  }));
  return { sessions, messages };
}

const eventOf = (message: BrokerMessage): BrokerEvent => ({ msgId: message.msgId, kind: message.kind, from: message.actor, text: message.body, at: message.ts, meta: { to: message.target } });

/** The broker serves at most its newest BROKER_HISTORY_LIMIT events, newest last. */
export function brokerHistoryItems(state: BrokerState): BrokerEvent[] {
  return state.messages.slice(-BROKER_HISTORY_LIMIT).map(eventOf);
}

/** The open questions addressed to the human. */
export function brokerQueueItems(state: BrokerState): BrokerEvent[] {
  return state.messages
    .filter((message) => message.target === "human")
    .slice(-BROKER_SIZES.queue)
    .map((message) => ({ ...eventOf(message), kind: "question" }));
}
