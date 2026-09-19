import { SSE_EVENTS, type SseMessage } from "@titan-design/rpc-protocol";
import type { EventHandlers, Subscription } from "./data-source.js";
import { createSseParser } from "./sse-parser.js";

export interface EventStreamOptions {
  url: string;
  fetch: typeof fetch;
  handlers: EventHandlers;
  signal?: AbortSignal;
  /** Wait after a stream that had opened; doubles per failed dial up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Holds one SSE connection open, redialling with capped backoff until closed or aborted. */
export function openEventStream(options: EventStreamOptions): Subscription {
  const controller = new AbortController();
  const close = (): void => controller.abort();
  if (options.signal?.aborted) close();
  options.signal?.addEventListener("abort", close, { once: true });
  void keepConnected(options, controller.signal).finally(() => {
    options.signal?.removeEventListener("abort", close);
    options.handlers.onStatus?.("closed");
  });
  return { close };
}

async function keepConnected(options: EventStreamOptions, signal: AbortSignal): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    options.handlers.onStatus?.("connecting");
    const opened = await readUntilDropped(options, signal);
    failures = opened ? 0 : failures + 1;
    await sleep(Math.min(options.baseDelayMs * 2 ** failures, options.maxDelayMs), signal);
  }
}

/** Reads one connection to its end. True when the daemon's `ready` frame arrived. */
async function readUntilDropped(options: EventStreamOptions, signal: AbortSignal): Promise<boolean> {
  let opened = false;
  try {
    const response = await options.fetch(options.url, { headers: { accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      for (const message of parse(decoder.decode(chunk.value, { stream: true }))) {
        opened = dispatch(message, options.handlers) || opened;
      }
    }
  } catch {
    // A refused dial, a dropped socket, and an abort all end this connection the same way.
  }
  return opened;
}

function dispatch(message: SseMessage, handlers: EventHandlers): boolean {
  if (message.event === SSE_EVENTS.READY) {
    handlers.onStatus?.("open");
    return true;
  }
  if (message.event === SSE_EVENTS.PING) return false;
  try {
    handlers.onEvent(message);
  } catch (err) {
    // Reported like an EventTarget listener error, so one bad handler cannot drop the stream.
    queueMicrotask(() => {
      throw err;
    });
  }
  return false;
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
