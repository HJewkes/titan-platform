import { openDatabase, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";

/**
 * A video's place in the pipeline (plan section 3). `seen`, `transcribed`, `scored` and
 * `mined` also come from the one-off seen-set import; the rest are the tick's own.
 */
export const VIDEO_STATES = [
  "new",
  "skipped:short",
  "index_only",
  "seen",
  "transcribed",
  "scored",
  "mined",
  "failed",
  "failed:live",
] as const;
export type VideoState = (typeof VIDEO_STATES)[number];

export const VIDEO_KINDS = ["vod", "short", "live", "upcoming", "post_live"] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "videos",
    up: (db) =>
      db.exec(`
        CREATE TABLE videos (
          id TEXT PRIMARY KEY,
          source TEXT,
          kind TEXT CHECK (kind IS NULL OR kind IN (${VIDEO_KINDS.map((k) => `'${k}'`).join(", ")})),
          title TEXT,
          detected_at TEXT NOT NULL,
          published TEXT,
          duration INTEGER,
          state TEXT NOT NULL CHECK (state IN (${VIDEO_STATES.map((s) => `'${s}'`).join(", ")})),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_retry_at TEXT,
          last_error_class TEXT,
          card TEXT
        );
        CREATE INDEX videos_state ON videos (state);
        CREATE INDEX videos_retry ON videos (next_retry_at) WHERE next_retry_at IS NOT NULL;
      `),
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

export function openScoutDb(file: string): Db {
  const db = openDatabase(file, { schemaVersion: SCHEMA_VERSION });
  runMigrations(db, MIGRATIONS);
  return db;
}

export interface VideoRow {
  id: string;
  source: string | null;
  kind: VideoKind | null;
  title: string | null;
  detected_at: string;
  published: string | null;
  duration: number | null;
  state: VideoState;
  attempts: number;
  next_retry_at: string | null;
  last_error_class: string | null;
  card: string | null;
}

export function getVideo(db: Db, id: string): VideoRow | undefined {
  return db.prepare<[string], VideoRow>("SELECT * FROM videos WHERE id = ?").get(id);
}

export function countByState(db: Db): Partial<Record<VideoState, number>> {
  const rows = db.prepare<[], { state: VideoState; n: number }>("SELECT state, COUNT(*) AS n FROM videos GROUP BY state ORDER BY state").all();
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}
