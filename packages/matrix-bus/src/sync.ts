import type { MatrixEvent, SyncBatch } from "./types.js";

export interface SyncOptions {
  since?: string;
  filter?: string | Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface JoinedTimeline {
  events?: MatrixEvent[];
  limited?: boolean;
  prev_batch?: string;
}

export interface SyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, { timeline?: JoinedTimeline }> };
}

export type SyncRequest = (query: Record<string, string | undefined>, signal?: AbortSignal) => Promise<SyncResponse>;

export function timelineEvents(res: SyncResponse): MatrixEvent[] {
  return Object.entries(res.rooms?.join ?? {}).flatMap(([roomId, room]) =>
    (room.timeline?.events ?? []).map((event) => ({ ...event, room_id: roomId })),
  );
}

// A batch spans every joined room, so limited is true if any room's timeline is limited.
function timelineGap(res: SyncResponse): { limited: boolean; prev_batch?: string } {
  const timelines = Object.values(res.rooms?.join ?? {}).map((room) => room.timeline ?? {});
  const limited = timelines.some((timeline) => timeline.limited === true);
  const prev_batch = timelines.find((timeline) => timeline.limited === true)?.prev_batch;
  return { limited, prev_batch };
}

function syncQuery(since: string | undefined, options: SyncOptions): Record<string, string | undefined> {
  const { filter, timeoutMs = 30_000 } = options;
  return {
    since,
    timeout: String(timeoutMs),
    filter: typeof filter === "object" ? JSON.stringify(filter) : filter,
  };
}

// Ends quietly on abort and rethrows anything else, so the caller owns retry and backoff.
export async function* syncBatches(request: SyncRequest, options: SyncOptions = {}): AsyncGenerator<SyncBatch> {
  const { signal } = options;
  let since = options.since;
  while (!signal?.aborted) {
    let res: SyncResponse;
    try {
      res = await request(syncQuery(since, options), signal);
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
    since = res.next_batch;
    yield { since, events: timelineEvents(res), ...timelineGap(res) };
  }
}
