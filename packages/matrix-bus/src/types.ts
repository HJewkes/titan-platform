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

export interface SyncBatch {
  since: string;
  events: MatrixEvent[];
}

export interface Session {
  userId: string;
  accessToken: string;
  deviceId?: string;
}
