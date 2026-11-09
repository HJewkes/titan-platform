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
 * One /sync response. `limited` is true when any joined room's timeline omitted older
 * events in the gap. `prev_batch` is the token from the first limited room and carries no
 * room id, so it is correct only when the /sync filter admits a single room (`#queue`):
 * with several rooms it may belong to a different room than the one being backfilled.
 * Page backward from it to backfill the gap (e.g. after a laptop sleep).
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
