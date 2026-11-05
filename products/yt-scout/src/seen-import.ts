import type { Db } from "@titan-design/store-sqlite";
import type { Watchlist } from "./config.js";
import { readSeenSources, type SeenRecord, type SeenSourceResult } from "./seen-sources.js";
import { countByState, getVideo, type VideoState } from "./store.js";

// The import only ever moves a video forward. Tick-owned states rank 0, so history wins over them.
const IMPORT_RANK: Partial<Record<VideoState, number>> = { seen: 1, transcribed: 2, mined: 3, scored: 4 };
const rank = (state: VideoState): number => IMPORT_RANK[state] ?? 0;

export interface SeenImportReport {
  sources: { name: string; present: boolean; ids: number }[];
  inserted: number;
  upgraded: number;
  unchanged: number;
  states: Partial<Record<VideoState, number>>;
}

/** Folds every record for one id into one: the furthest state, and the first value seen for each field. */
export function mergeRecords(records: readonly SeenRecord[]): Map<string, SeenRecord> {
  const merged = new Map<string, SeenRecord>();
  for (const r of records) {
    const prior = merged.get(r.id);
    if (!prior) {
      merged.set(r.id, { ...r });
      continue;
    }
    const lead = rank(r.state) > rank(prior.state) ? r : prior;
    merged.set(r.id, {
      id: r.id,
      state: lead.state,
      channel: prior.channel ?? r.channel,
      title: prior.title ?? r.title,
      published: prior.published ?? r.published,
      duration: prior.duration ?? r.duration,
      card: prior.card ?? r.card,
    });
  }
  return merged;
}

/** A history channel name or handle becomes its watch-list key when one matches; otherwise it is kept as-is. */
export function sourceResolver(watchlist: Watchlist): (channel: string | undefined) => string | null {
  const byName = new Map<string, string>();
  for (const s of watchlist.sources) {
    for (const alias of [s.key, s.handle, s.name]) if (alias) byName.set(alias.toLowerCase(), s.key);
  }
  return (channel) => (channel === undefined ? null : (byName.get(channel.replace(/^@/, "").toLowerCase()) ?? channel));
}

type Outcome = "inserted" | "upgraded" | "unchanged";

function applyRecord(db: Db, r: SeenRecord, source: string | null, now: string): Outcome {
  const existing = getVideo(db, r.id);
  if (!existing) {
    db.prepare(
      `INSERT INTO videos (id, source, title, detected_at, published, duration, state, card)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, source, r.title ?? null, now, r.published ?? null, r.duration ?? null, r.state, r.card ?? null);
    return "inserted";
  }
  const advance = rank(r.state) > rank(existing.state);
  db.prepare(
    `UPDATE videos SET source = COALESCE(source, ?), title = COALESCE(title, ?), published = COALESCE(published, ?),
       duration = COALESCE(duration, ?), card = COALESCE(card, ?), state = ? WHERE id = ?`,
  ).run(source, r.title ?? null, r.published ?? null, r.duration ?? null, r.card ?? null, advance ? r.state : existing.state, r.id);
  return advance ? "upgraded" : "unchanged";
}

function summarise(results: readonly SeenSourceResult[]): SeenImportReport["sources"] {
  return results.map((s) => ({ name: s.name, present: s.present, ids: new Set(s.records.map((r) => r.id)).size }));
}

/** Loads the pre-scout seen-set into `videos` in one transaction. A rerun on the same files adds nothing. */
export function importSeen(db: Db, root: string, watchlist: Watchlist, now: () => Date = () => new Date()): SeenImportReport {
  const results = readSeenSources(root);
  const merged = mergeRecords(results.flatMap((s) => s.records));
  const resolve = sourceResolver(watchlist);
  const stamp = now().toISOString();
  const tally: Record<Outcome, number> = { inserted: 0, upgraded: 0, unchanged: 0 };
  db.transaction(() => {
    for (const r of merged.values()) tally[applyRecord(db, r, resolve(r.channel), stamp)]++;
  })();
  return { sources: summarise(results), ...tally, states: countByState(db) };
}

export function formatSeenImport(report: SeenImportReport): string[] {
  const sources = report.sources.map((s) => `${s.name} ${s.present ? s.ids : "missing"}`).join(", ");
  const states = Object.entries(report.states)
    .map(([state, n]) => `${state} ${n}`)
    .join(", ");
  return [
    `read: ${sources}`,
    `inserted ${report.inserted}, upgraded ${report.upgraded}, unchanged ${report.unchanged}`,
    `videos by state: ${states}`,
  ];
}
