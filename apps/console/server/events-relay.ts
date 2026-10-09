import type { EventHub, Logger, SseMessage } from "@titan-design/daemon";
import { createSseParser } from "@titan-design/rpc-client";
import { TOKEN_HEADER, readToken } from "./broker.js";
import type { ConsoleConfig } from "./config.js";

/** The SSE event names the browser sees; each relayed frame is named for the upstream it came from. */
export const RELAY_SOURCES = ["active-work", "agent-chat"] as const;
export type RelaySource = (typeof RELAY_SOURCES)[number];

/** A kind the browser gets after an upstream stream reopens, since frames sent while it was down are lost. */
export const RECONNECTED_KIND = "reconnected";

/**
 * The data of one relayed frame. Only the kind and the ids a page needs to decide what to refetch:
 * an upstream frame's body, meta, ref and any path it names never reach the browser.
 */
export interface RelayedEvent {
  kind: string;
  /** The broker's event-log row id. */
  id?: number;
  /** Agent names, which `agents.roster` already shows. */
  actor?: string;
  target?: string;
}

export type RelayedIds = Omit<RelayedEvent, "kind">;

export interface RelayUpstream {
  source: RelaySource;
  url: string;
  /** Read on every dial, so a rotated token needs no restart; a throw counts as a failed dial. */
  headers(): Promise<Record<string, string>>;
  /** The ids kept from one upstream frame's data. */
  pick(data: string): RelayedIds;
}

export interface RelayTiming {
  baseDelayMs: number;
  maxDelayMs: number;
  /** A dial with no response headers by then is abandoned. */
  dialTimeoutMs: number;
  /** Both upstreams send a heartbeat every 25 s, so a stream silent this long is dead. */
  idleTimeoutMs: number;
}

export const DEFAULT_RELAY_TIMING: RelayTiming = { baseDelayMs: 500, maxDelayMs: 30_000, dialTimeoutMs: 3000, idleTimeoutMs: 60_000 };

/** An unterminated frame past this many characters drops the connection rather than growing the parser's buffer. */
export const MAX_FRAME_CHARS = 1 << 20;

/** The daemon package's reserved frames; active-work sends both, the broker heartbeats with a comment. */
const KEEPALIVES = new Set(["ready", "ping"]);
const KIND = /^[A-Za-z][\w.-]{0,63}$/;
const AGENT_NAME = /^[\w.:@-]{1,128}$/;

export interface RelayOptions {
  hub: Pick<EventHub, "broadcast">;
  upstreams: readonly RelayUpstream[];
  logger: Logger;
  fetch?: typeof fetch;
  timing?: Partial<RelayTiming>;
}

export interface EventsRelay {
  /** Aborts every dial, read and backoff wait, and resolves once each upstream loop has ended. Idempotent. */
  close(): Promise<void>;
}

interface RelayContext {
  hub: Pick<EventHub, "broadcast">;
  logger: Logger;
  fetch: typeof fetch;
  timing: RelayTiming;
}

/** One connection per upstream, redialled with capped backoff until closed; never throws. */
export function startEventsRelay(options: RelayOptions): EventsRelay {
  const controller = new AbortController();
  const context: RelayContext = {
    hub: options.hub,
    logger: options.logger,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    timing: { ...DEFAULT_RELAY_TIMING, ...options.timing },
  };
  const runs = options.upstreams.map((upstream) => keepRelaying(upstream, context, controller.signal));
  return {
    close: async () => {
      controller.abort();
      await Promise.allSettled(runs);
    },
  };
}

/** The console's two upstreams, on loopback, with the broker token sent as a header and never relayed. */
export function relayUpstreams(config: ConsoleConfig): RelayUpstream[] {
  const accept = { accept: "text/event-stream" };
  return [
    { source: "active-work", url: `http://127.0.0.1:${config.activeWorkPort}/events`, headers: async () => accept, pick: () => ({}) },
    {
      source: "agent-chat",
      url: `http://127.0.0.1:${config.agentChatPort}/events`,
      headers: async () => ({ ...accept, [TOKEN_HEADER]: await readToken(config.agentChatTokenPath) }),
      pick: brokerIds,
    },
  ];
}

/** A broker frame's data is its event-log row; only the row id and the two agent names are kept. */
export function brokerIds(data: string): RelayedIds {
  const row = parseObject(data);
  if (!row) return {};
  const ids: RelayedIds = {};
  if (Number.isSafeInteger(row.id)) ids.id = row.id as number;
  if (typeof row.actor === "string" && AGENT_NAME.test(row.actor)) ids.actor = row.actor;
  if (typeof row.target === "string" && AGENT_NAME.test(row.target)) ids.target = row.target;
  return ids;
}

function parseObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function keepRelaying(upstream: RelayUpstream, context: RelayContext, signal: AbortSignal): Promise<void> {
  const { timing, logger } = context;
  let failures = 0;
  let everOpened = false;
  let down = false;
  while (!signal.aborted) {
    const outcome = await relayOnce(upstream, context, signal, everOpened);
    if (signal.aborted) return;
    everOpened ||= outcome.opened;
    failures = outcome.opened ? 0 : failures + 1;
    if (!down) logger.warn({ source: upstream.source, reason: outcome.reason }, "events relay: upstream stream down; redialling with backoff");
    down = !outcome.opened;
    await sleep(Math.min(timing.baseDelayMs * 2 ** failures, timing.maxDelayMs), signal);
  }
}

interface Outcome {
  opened: boolean;
  reason: string;
}

/** Reads one connection to its end; `opened` once the upstream answered 200 with a body. */
async function relayOnce(upstream: RelayUpstream, context: RelayContext, signal: AbortSignal, reopening: boolean): Promise<Outcome> {
  const connection = new AbortController();
  const stop = (): void => connection.abort();
  signal.addEventListener("abort", stop, { once: true });
  const watchdog = createWatchdog(stop);
  let opened = false;
  try {
    const headers = await upstream.headers();
    watchdog.arm(context.timing.dialTimeoutMs);
    // A followed redirect would carry the broker token to wherever the Location points.
    const response = await context.fetch(upstream.url, { headers, redirect: "error", signal: connection.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { opened, reason: `HTTP ${response.status}` };
    }
    opened = true;
    if (reopening) broadcast(context.hub, upstream.source, { kind: RECONNECTED_KIND });
    await pump(response.body, upstream, context, watchdog);
    return { opened, reason: "stream ended" };
  } catch (err) {
    return { opened, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    watchdog.clear();
    signal.removeEventListener("abort", stop);
  }
}

async function pump(body: ReadableStream<Uint8Array>, upstream: RelayUpstream, context: RelayContext, watchdog: Watchdog): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  let unterminated = 0;
  watchdog.arm(context.timing.idleTimeoutMs);
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      watchdog.arm(context.timing.idleTimeoutMs);
      const text = decoder.decode(chunk.value, { stream: true });
      const frames = parse(text);
      unterminated = frames.length > 0 || text.includes("\n\n") ? 0 : unterminated + text.length;
      if (unterminated > MAX_FRAME_CHARS) throw new Error(`a frame passed ${MAX_FRAME_CHARS} characters`);
      for (const frame of frames) relayFrame(frame, upstream, context.hub);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Exactly one relayed frame per upstream frame, keep-alives aside. */
function relayFrame(frame: SseMessage, upstream: RelayUpstream, hub: Pick<EventHub, "broadcast">): void {
  if (KEEPALIVES.has(frame.event)) return;
  broadcast(hub, upstream.source, { kind: KIND.test(frame.event) ? frame.event : "unknown", ...upstream.pick(frame.data) });
}

function broadcast(hub: Pick<EventHub, "broadcast">, source: RelaySource, event: RelayedEvent): void {
  hub.broadcast({ event: source, data: JSON.stringify(event) });
}

interface Watchdog {
  /** (Re)starts the one timer; it fires `onExpire` unless re-armed or cleared first. */
  arm(ms: number): void;
  clear(): void;
}

function createWatchdog(onExpire: () => void): Watchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => clearTimeout(timer);
  return {
    arm: (ms) => {
      clear();
      timer = setTimeout(onExpire, ms);
      timer.unref();
    },
    clear,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
