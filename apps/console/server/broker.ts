import { readFile } from "node:fs/promises";
import { brokerHistory, brokerSessions, type BrokerEvent, type BrokerSession } from "@titan-design/chat-protocol/agents";
import { EXIT } from "@titan-design/registry";
import type { z } from "zod";

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
  /** agent-chat's 0600 `ui.token`, re-read on every call so a rotated token needs no restart. */
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
    const res = await doFetch(url, { headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err: unknown) => {
      throw new BrokerUnavailable(`agent-chat broker not answering on port ${options.port}: ${(err as Error).message}`);
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new BrokerUnavailable(`agent-chat broker ${route} answered ${res.status}`);
    }
    return schema.parse(await res.json());
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
  const text = await readFile(file, "utf8").catch(() => null);
  const token = text?.trim();
  if (!token) throw new BrokerUnavailable(`agent-chat ui token not readable at ${file}`);
  return token;
}
