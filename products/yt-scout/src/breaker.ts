import type { Db } from "@titan-design/store-sqlite";

export const BREAKER_MIN_MS = 2 * 3_600_000;
export const BREAKER_MAX_MS = 24 * 3_600_000;

export interface BreakerState {
  openUntil: string | null;
  cooldownMs: number;
}

export interface BreakerStore {
  read(): BreakerState;
  write(state: BreakerState): void;
}

export function memoryBreaker(initial: BreakerState = { openUntil: null, cooldownMs: 0 }): BreakerStore {
  let state = initial;
  return { read: () => state, write: (s) => void (state = s) };
}

// Created on demand rather than by a migration, so parallel slices adding migrations cannot collide on a version.
export function sqliteBreaker(db: Db): BreakerStore {
  db.exec("CREATE TABLE IF NOT EXISTS transcribe_breaker (id INTEGER PRIMARY KEY CHECK (id = 1), open_until TEXT, cooldown_ms INTEGER NOT NULL)");
  return {
    read() {
      const row = db.prepare<[], { open_until: string | null; cooldown_ms: number }>("SELECT open_until, cooldown_ms FROM transcribe_breaker WHERE id = 1").get();
      return row ? { openUntil: row.open_until, cooldownMs: row.cooldown_ms } : { openUntil: null, cooldownMs: 0 };
    },
    write(s) {
      db.prepare("INSERT INTO transcribe_breaker (id, open_until, cooldown_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET open_until = excluded.open_until, cooldown_ms = excluded.cooldown_ms").run(s.openUntil, s.cooldownMs);
    },
  };
}

export const isOpen = (s: BreakerState, now: Date): boolean => s.openUntil !== null && s.openUntil > now.toISOString();

/** Start at 2 h, double on each repeat trip, cap at 24 h. */
export function trip(s: BreakerState, now: Date): BreakerState {
  const cooldownMs = s.cooldownMs === 0 ? BREAKER_MIN_MS : Math.min(s.cooldownMs * 2, BREAKER_MAX_MS);
  return { openUntil: new Date(now.getTime() + cooldownMs).toISOString(), cooldownMs };
}

export const reset = (): BreakerState => ({ openUntil: null, cooldownMs: 0 });
