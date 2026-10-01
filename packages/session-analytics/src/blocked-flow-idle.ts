/** A seat journal line that states its implementer slot count, and why it did not fill a free slot. */
export interface SlotTick {
  seat: string;
  at: string;
  used: number;
  cap: number;
  reason: string;
  /** The journal line number, so a row can be checked against its source. */
  line: number;
}

export interface SeatJournal {
  ticks: SlotTick[];
  /** The journal's last timestamped line; the final tick holds until then. */
  lastAt: string | null;
}

export const UNSTATED_REASON = "unstated";

/** A tick's count holds at most this long, so a dark seat is not read as an hour of idle slots. */
export const TICK_HOLD_MAX_MIN = 60;

const STAMP = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s/;
const IMPL = /\bimpl(?:ementers?)?\s+(\d+)\s*\/\s*(\d+)/i;
const REASON = /\b(?:no dispatch|dispatch 0)\s*:\s*([^.;(]+)/i;

/**
 * Reads `HH:MM[:SS] ...` journal lines for the date the journal covers.
 * `utcOffsetMin` is the journal clock's offset east of UTC, such as -360 for UTC-6.
 */
export function parseSeatJournal(text: string, seat: string, date: string, utcOffsetMin: number): SeatJournal {
  const ticks: SlotTick[] = [];
  let lastAt: string | null = null;
  text.split("\n").forEach((raw, index) => {
    const stamp = STAMP.exec(raw);
    if (!stamp) return;
    const at = journalTime(date, stamp, utcOffsetMin);
    lastAt = at;
    const impl = IMPL.exec(raw);
    if (!impl) return;
    const used = Number(impl[1]);
    const cap = Number(impl[2]);
    const reason = used < cap ? (REASON.exec(raw)?.[1]?.trim().toLowerCase() ?? UNSTATED_REASON) : "";
    ticks.push({ seat, at, used, cap, reason, line: index + 1 });
  });
  return { ticks, lastAt };
}

function journalTime(date: string, stamp: RegExpExecArray, utcOffsetMin: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const local = Date.UTC(year!, month! - 1, day!, Number(stamp[1]), Number(stamp[2]), Number(stamp[3] ?? 0));
  return new Date(local - utcOffsetMin * 60_000).toISOString();
}

export interface IdleSlotRow {
  seat: string;
  reason: string;
  slotMinutes: number;
  ticks: number;
  /** Journal line numbers of the ticks counted here. */
  lines: number[];
}

/** Free implementer slots times the minutes each tick's count held, clipped to the window. */
export function idleSlotMinutes(journals: readonly SeatJournal[], window: { since?: string; until?: string }): IdleSlotRow[] {
  const rows = new Map<string, IdleSlotRow>();
  for (const journal of journals) {
    journal.ticks.forEach((tick, i) => {
      const free = Math.max(0, tick.cap - tick.used);
      const held = heldMinutes(tick.at, journal.ticks[i + 1]?.at ?? journal.lastAt ?? tick.at, window);
      if (free === 0 || held <= 0) return;
      const key = `${tick.seat}\u0000${tick.reason}`;
      const row = rows.get(key) ?? { seat: tick.seat, reason: tick.reason, slotMinutes: 0, ticks: 0, lines: [] };
      rows.set(key, { ...row, slotMinutes: row.slotMinutes + free * held, ticks: row.ticks + 1, lines: [...row.lines, tick.line] });
    });
  }
  return [...rows.values()].map((r) => ({ ...r, slotMinutes: Math.round(r.slotMinutes) })).sort((a, b) => b.slotMinutes - a.slotMinutes);
}

function heldMinutes(from: string, to: string, window: { since?: string; until?: string }): number {
  const start = Math.max(Date.parse(from), window.since ? Date.parse(window.since) : -Infinity);
  const capped = Math.min(Date.parse(to), Date.parse(from) + TICK_HOLD_MAX_MIN * 60_000);
  const end = Math.min(capped, window.until ? Date.parse(window.until) : Infinity);
  return Math.max(0, (end - start) / 60_000);
}
