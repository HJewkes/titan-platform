import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SseParser, parseFrameData, type EventBook, type SseFrame } from "./events.js";
import type { BrokerAddress } from "./sources.js";

/** The broker's replay ceiling (`MAX_REPLAY_ROWS`): a wider gap is answered with `reset`. */
export const REPLAY_ROWS = 500;
const RETRY_MS = 5_000;

type FrameOutcome = "changed" | "unchanged" | "restart";

/**
 * Folds frames into the book. The first `reset` (a fresh client is always too far behind)
 * asks for a reconnect that replays the newest `REPLAY_ROWS`, so recent Status reports are
 * known at start; a later one only moves the cursor.
 */
export class EventFollower {
  private backfilled = false;

  constructor(private readonly book: EventBook) {}

  get since(): number {
    return this.book.latestId;
  }

  frame(frame: SseFrame): FrameOutcome {
    if (frame.event !== "reset") return this.book.accept(frame) ? "changed" : "unchanged";
    const data = parseFrameData(frame.data);
    const latestId = typeof data === "object" && data !== null && "latestId" in data ? data.latestId : null;
    if (typeof latestId !== "number") return "unchanged";
    if (this.backfilled) {
      this.book.skipTo(latestId);
      return "changed";
    }
    this.backfilled = true;
    this.book.skipTo(Math.max(0, latestId - REPLAY_ROWS));
    return "restart";
  }
}

interface FollowOptions {
  address: BrokerAddress;
  follower: EventFollower;
  onChange: () => void;
  /** Null once the stream is healthy again. */
  onError: (message: string | null) => void;
  signal: AbortSignal;
}

async function readToken(home: string): Promise<string> {
  return (await readFile(join(home, "ui.token"), "utf8")).trim();
}

/** One connection: true when the follower asked to reconnect from its new cursor. */
async function follow(options: FollowOptions, token: string): Promise<boolean> {
  const { address, follower, signal } = options;
  const url = `http://127.0.0.1:${address.port}/events?since=${follower.since}`;
  const res = await fetch(url, { headers: { "X-Agent-Chat-Token": token }, signal });
  if (!res.ok || res.body === null) throw new Error(`/events answered ${res.status}`);
  options.onError(null);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
      const outcome = follower.frame(frame);
      if (outcome === "restart") return true;
      if (outcome === "changed") options.onChange();
    }
  }
  throw new Error("the broker closed the event stream");
}

/** Follows `/events` until aborted, reconnecting after a failure. The token travels in a header, never on argv. */
export async function followEvents(options: FollowOptions): Promise<void> {
  while (!options.signal.aborted) {
    try {
      if (await follow(options, await readToken(options.address.home))) continue;
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}
