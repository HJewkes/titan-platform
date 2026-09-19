import { EVENTS_PATH, EXIT, RPC_PREFIX, errorEnvelope, type JsonEnvelope } from "@titan-design/rpc-protocol";
import { checkedWireArgs } from "./canonical-key.js";
import type { DataSource } from "./data-source.js";
import { isEnvelope } from "./envelope-shape.js";
import { openEventStream } from "./event-stream.js";

export interface LiveSourceOptions {
  /** Daemon origin such as `http://127.0.0.1:7400`; empty means the page's own origin. */
  origin?: string;
  /** Defaults to the global `fetch`; inject one to add headers or run under a test double. */
  fetch?: typeof fetch;
  /** First redial delay after a dropped event stream. Defaults to 500. */
  reconnectDelayMs?: number;
  /** Cap on the doubling redial delay. Defaults to 10000. */
  maxReconnectDelayMs?: number;
}

/** A running daemon: `POST /rpc/<name>` for calls and `/events` for pushes. */
export function liveSource(options: LiveSourceOptions = {}): DataSource {
  const origin = (options.origin ?? "").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    call: (name, args, callOptions) =>
      postRpc(doFetch, `${origin}${RPC_PREFIX}${encodeURIComponent(name)}`, args, callOptions?.signal),
    subscribe: (handlers, subscribeOptions) =>
      openEventStream({
        url: `${origin}${EVENTS_PATH}`,
        fetch: doFetch,
        handlers,
        signal: subscribeOptions?.signal,
        baseDelayMs: options.reconnectDelayMs ?? 500,
        maxDelayMs: options.maxReconnectDelayMs ?? 10_000,
      }),
  };
}

async function postRpc(
  doFetch: typeof fetch,
  url: string,
  args: unknown,
  signal: AbortSignal | undefined,
): Promise<JsonEnvelope<unknown>> {
  const wire = checkedWireArgs(args);
  if (!wire.ok) return wire;
  // The daemon's guards refuse a state-changing request without a JSON content type (415).
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wire.data), signal };
  try {
    const response = await doFetch(url, init);
    const body: unknown = await response.json().catch(() => undefined);
    signal?.throwIfAborted();
    if (isEnvelope(body)) return body;
    return errorEnvelope(`Daemon answered HTTP ${response.status} without an envelope`, EXIT.UNAVAILABLE);
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    return errorEnvelope(`Daemon unreachable: ${err instanceof Error ? err.message : String(err)}`, EXIT.UNAVAILABLE);
  }
}
