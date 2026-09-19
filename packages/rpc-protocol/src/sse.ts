/** One server-sent event frame: `event: <event>\ndata: <data>\n\n`. */
export interface SseMessage {
  event: string;
  data: string;
}

/** Event names the daemon emits on its own; products broadcast any other name. */
export const SSE_EVENTS = {
  /** Sent once on connect, with `SSE_READY_DATA` as its data. */
  READY: "ready",
  /** Keep-alive every `SSE_HEARTBEAT_MS`; its data is the server's `Date.now()`. */
  PING: "ping",
} as const;

export const SSE_READY_DATA = "connected";

/** Interval between SSE keep-alive frames (ms). */
export const SSE_HEARTBEAT_MS = 25_000;
