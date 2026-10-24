import type { DigestItem } from "../../digest.js";
import type { DayWindow } from "./session-source.js";

export interface DecisionSourceResult {
  items: DigestItem[];
  notes: string[];
}

const ENTRY = /^(\d{3,})([a-z]?)\. (.*)$/;
const STAMP = /(\d{4}-\d{2}-\d{2})[ T]~?(\d{2})(?::(\d{2}|\dx|xx))?(?::\d{2})?\s?(Z|MDT|MST)?/;
const SAME = /\bsame (time|round)\b/i;
const QUOTED = /["“]([^"”]{3,}?)["”]/;
const STAMP_SPAN = 200;
const TITLE_SPAN = 160;
const ZONE_OFFSET_H: Record<string, number> = { Z: 0, MDT: 6, MST: 7 };

// An approximate minute (`~18:3x`) floors to its ten, and a zoneless stamp is read as UTC.
function stampOf(text: string): string | undefined {
  const match = STAMP.exec(text.slice(0, STAMP_SPAN));
  if (!match) return undefined;
  const [, date, hour, minute = "00", zone = "Z"] = match;
  const at = Date.parse(`${date}T${hour}:${minute.replace(/x/g, "0").padStart(2, "0")}:00Z`);
  if (Number.isNaN(at)) return undefined;
  return new Date(at + ZONE_OFFSET_H[zone]! * 3_600_000).toISOString();
}

function titleOf(text: string): string {
  const quoted = QUOTED.exec(text)?.[1]?.trim();
  return quoted && quoted.length <= TITLE_SPAN ? quoted : text.slice(0, TITLE_SPAN).trim();
}

const inWindow = (at: string, window: DayWindow) => at >= window.since && at < window.until;

/**
 * The owner decisions stamped inside the window, from a decisions log of numbered top-level entries
 * (`530. Owner 2026-01-02 ~18:0xZ ...`). An entry "at the same time" or "same round" takes the stamp of the entry
 * before it; an entry with no stamp is skipped and counted in one note. Sub-items and headings are not decisions.
 */
export function decisionItems(text: string, window: DayWindow): DecisionSourceResult {
  const items = new Map<string, DigestItem>();
  let previous: string | undefined;
  let undated = 0;
  for (const line of text.split("\n")) {
    const match = ENTRY.exec(line);
    if (!match) continue;
    const [, number, suffix, body = ""] = match;
    const at = stampOf(body) ?? (SAME.test(body.slice(0, STAMP_SPAN)) ? previous : undefined);
    if (!at) {
      undated += 1;
      continue;
    }
    previous = at;
    const id = `decision/${number}${suffix}`;
    if (inWindow(at, window) && !items.has(id)) items.set(id, { id, kind: "decision", title: titleOf(body), at, priority: "P1" });
  }
  return { items: [...items.values()], notes: undated > 0 ? [`decisions log: skipped ${undated} numbered ${undated === 1 ? "entry" : "entries"} with no date stamp`] : [] };
}
