import { open } from "node:fs/promises";
import { brokerHistory, brokerSessions, type BrokerEvent, type BrokerSession } from "@titan-design/chat-protocol/agents";
import { EXIT } from "@titan-design/registry";
import type { z } from "zod";
import { failure, unexpectedShape } from "./active-work.js";

/** agent-chat's MAX_HISTORY_LIMIT: the deepest window the broker serves, which keeps spawn edges longest. */
export const BROKER_HISTORY_LIMIT = 1000;

/** The header agent-chat's `/api/*` guard reads; the same one its own queue mirror sends. */
const TOKEN_HEADER = "X-Agent-Chat-Token";
const TIMEOUT_MS = 3000;

export interface BrokerSnapshot {
  sessions: BrokerSession[];
  brokerUptimeMs: number;
  events: BrokerEvent[];
}

/** Read-only access to the broker: no answer, dismiss or approve call exists here. */
export interface BrokerReader {
  read(): Promise<BrokerSnapshot>;
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
  return {
    read: async () => {
      const token = await readToken(options.tokenPath);
      const [sessions, history] = await Promise.all([
        get("/api/sessions", brokerSessions, token),
        get(`/api/history?limit=${BROKER_HISTORY_LIMIT}`, brokerHistory, token),
      ]);
      return { ...sessions, events: history.items };
    },
  };
}

async function readToken(file: string): Promise<string> {
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
