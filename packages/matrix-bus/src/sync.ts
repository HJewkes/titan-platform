import type { MatrixEvent, SyncBatch } from "./types.js";

export interface SyncOptions {
  since?: string;
  filter?: string | Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> };
}

export type SyncRequest = (query: Record<string, string | undefined>, signal?: AbortSignal) => Promise<SyncResponse>;

export function timelineEvents(res: SyncResponse): MatrixEvent[] {
  return Object.entries(res.rooms?.join ?? {}).flatMap(([roomId, room]) =>
    (room.timeline?.events ?? []).map((event) => ({ ...event, room_id: roomId })),
  );
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
    yield { since, events: timelineEvents(res) };
  }
}
