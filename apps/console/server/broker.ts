import { open } from "node:fs/promises";
import { brokerHistory, brokerSessions, type BrokerEvent, type BrokerSession } from "@titan-design/chat-protocol/agents";
import { EXIT } from "@titan-design/registry";
import { hasColumn, openDatabase, type Db } from "@titan-design/store-sqlite";
import type { z } from "zod";
import { failure, unexpectedShape } from "./active-work.js";

/** agent-chat's MAX_HISTORY_LIMIT: the deepest window the broker serves, which keeps spawn edges longest. */
export const BROKER_HISTORY_LIMIT = 1000;

/** The header agent-chat's `/api/*` guard reads; the same one its own queue mirror sends. */
export const TOKEN_HEADER = "X-Agent-Chat-Token";
const TIMEOUT_MS = 3000;

export interface BrokerSnapshot {
  sessions: BrokerSession[];
  brokerUptimeMs: number;
  events: BrokerEvent[];
}

/** Read-only access to the broker: no answer, dismiss or approve call exists here. */
export interface BrokerReader {
  read(): Promise<BrokerSnapshot>;
  /** The newest BROKER_HISTORY_LIMIT events; the broker gives no cursor past them. */
  history(): Promise<BrokerEvent[]>;
  /** Every open item addressed to the human, unwindowed. Both routes share one item shape. */
  queue(): Promise<BrokerEvent[]>;
}

export interface BrokerReaderOptions {
  port: number;
  /** agent-chat's 0600 `ui.token`, re-read on every call so a rotated token needs no restart; refused if group or others have any access. */
  tokenPath: string;
  fetch?: typeof fetch;
}

class BrokerUnavailable extends Error {
  readonly code = EXIT.UNAVAILABLE;
}

const HISTORY_ROUTE = `/api/history?limit=${BROKER_HISTORY_LIMIT}`;

export function brokerReader(options: BrokerReaderOptions): BrokerReader {
  const doFetch = options.fetch ?? fetch;
  const get = async <T>(route: string, schema: z.ZodType<T>, token: string): Promise<T> => {
    const url = `http://127.0.0.1:${options.port}${route}`;
    // A followed redirect would carry the token header to wherever the Location points.
    const init: RequestInit = { headers: { [TOKEN_HEADER]: token }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) };
    const res = await doFetch(url, init).catch((err: unknown) => {
      throw new BrokerUnavailable(`agent-chat broker not answering on port ${options.port}: ${(err as Error).message}`);
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new BrokerUnavailable(`agent-chat broker ${route} answered ${res.status}`);
    }
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw unexpectedShape(`agent-chat broker ${route}`);
    return parsed.data;
  };
  const items = async (route: string) => (await get(route, brokerHistory, await readToken(options.tokenPath))).items;
  return {
    read: async () => {
      const token = await readToken(options.tokenPath);
      const [sessions, history] = await Promise.all([get("/api/sessions", brokerSessions, token), get(HISTORY_ROUTE, brokerHistory, token)]);
      return { ...sessions, events: history.items };
    },
    history: () => items(HISTORY_ROUTE),
    queue: () => items("/api/queue"),
  };
}

export async function readToken(file: string): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) throw new BrokerUnavailable(`agent-chat ui token not readable at ${file}`);
  try {
    // Checked on the open handle, so the mode belongs to the bytes read below.
    const { mode } = await handle.stat();
    if (mode & 0o077) {
      throw failure(`agent-chat ui token at ${file} is mode ${(mode & 0o777).toString(8)}; refusing it until it is 600 (chmod 600 ${file})`, EXIT.CONFIG);
    }
    const token = (await handle.readFile("utf8")).trim();
    if (!token) throw new BrokerUnavailable(`agent-chat ui token not readable at ${file}`);
    return token;
  } finally {
    await handle.close();
  }
}

/** The conversation kinds agents.messages pages through; lifecycle rows are most of the log and stay out. */
export const MESSAGE_KINDS = ["message", "broadcast", "question", "answer", "decided"] as const;

/** The subset of agent-chat's internal `events` table this console reads; agent-chat owns the schema, so it is checked on every open. */
const EVENT_COLUMNS = ["id", "ts", "kind", "actor", "target", "msg_id", "ref", "body", "meta"] as const;
const BUSY_TIMEOUT_MS = 1000;

export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  target: string | null;
  msg_id: string | null;
  ref: string | null;
  body: string | null;
  meta: string | null;
}

export interface MessageQuery {
  /** Absent for every agent's messages, the console's whole feed. */
  agent?: string;
  /** With a peer, only the two agents' messages to each other. */
  peer?: string;
  /** Rows with an id below this; absent for the newest page. */
  before?: number;
  limit: number;
}

/** One page of conversation rows from agent-chat's events.db, newest first, or null when the file is absent or will not open. */
export function readMessageRows(file: string, query: MessageQuery): EventRow[] | null {
  const db = openReadOnly(file);
  if (!db) return null;
  try {
    const missing = EVENT_COLUMNS.filter((column) => !hasColumn(db, "events", column));
    if (missing.length > 0) throw new BrokerUnavailable(`agent-chat events.db at ${file} has no events column ${missing.join(", ")}`);
    const sql = `SELECT ${EVENT_COLUMNS.join(", ")} FROM events WHERE kind IN (${MESSAGE_KINDS.map((k) => `'${k}'`).join(", ")}) AND ${partyClause(query)} AND id < @before ORDER BY id DESC LIMIT @limit`;
    const params = {
      before: query.before ?? Number.MAX_SAFE_INTEGER,
      limit: query.limit,
      ...(query.agent === undefined ? {} : { agent: query.agent }),
      ...(query.peer === undefined ? {} : { peer: query.peer }),
    };
    return db.prepare(sql).all(params) as EventRow[];
  } finally {
    db.close();
  }
}

function partyClause({ agent, peer }: MessageQuery): string {
  if (agent === undefined) return "1 = 1";
  return peer === undefined ? "(actor = @agent OR target = @agent)" : "((actor = @agent AND target = @peer) OR (actor = @peer AND target = @agent))";
}

function openReadOnly(file: string): Db | null {
  try {
    // readonly never sets journal_mode, so the broker's WAL writer is left alone.
    const db = openDatabase(file, { readonly: true, foreignKeys: false });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
    return null;
  }
}
