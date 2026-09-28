export interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  content: Record<string, unknown>;
  origin_server_ts?: number;
  state_key?: string;
  room_id?: string;
  unsigned?: Record<string, unknown>;
}

export interface MessagesPage {
  chunk: MatrixEvent[];
  start: string;
  end?: string;
  state?: MatrixEvent[];
}

/**
 * One /sync response. The bus is used for a single room (`#queue`), so `limited` and
 * `prev_batch` come from that room's timeline: `limited` true means the server omitted
 * older events in the gap, and `prev_batch` is the token to page backward from to
 * backfill it (e.g. after the client was offline, such as a laptop sleep).
 */
export interface SyncBatch {
  since: string;
  events: MatrixEvent[];
  limited: boolean;
  prev_batch?: string;
}

export interface Session {
  userId: string;
  accessToken: string;
  deviceId?: string;
}
