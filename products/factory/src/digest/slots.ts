import type { DigestSlot } from "./model.js";

export const DEFAULT_SLOTS: readonly number[] = [6, 12, 18];
export const DEFAULT_TIMEZONE = "America/Denver";

interface LocalTime {
  date: string;
  hour: number;
  minute: number;
}

function localTime(at: Date, timeZone: string): LocalTime {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const part = (type: string): string => format.formatToParts(at).find((p) => p.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")), minute: Number(part("minute")) };
}

export interface SlotWindow {
  slot: DigestSlot;
  /** Minutes back to the previous slot, which is where this digest's window starts. */
  windowMinutes: number;
}

/** The latest slot at or before `now` in `timeZone`; before the first slot of a day it is the previous day's last. */
export function currentSlot(now: Date, timeZone: string, slots: readonly number[]): SlotWindow {
  const hours = [...new Set(slots)].sort((a, b) => a - b);
  const local = localTime(now, timeZone);
  const index = hours.filter((hour) => hour <= local.hour).length - 1;
  const hour = index >= 0 ? hours[index]! : hours.at(-1)!;
  const date = index >= 0 ? local.date : localTime(new Date(now.getTime() - (local.hour * 60 + local.minute + 1) * 60_000), timeZone).date;
  const previous = hours[(index >= 0 ? index : hours.length - 1) - 1] ?? hours.at(-1)! - 24;
  const sinceSlot = ((local.hour - hour + 24) % 24) * 60 + local.minute;
  return { slot: { date, hour: String(hour).padStart(2, "0") }, windowMinutes: sinceSlot + (hour - previous) * 60 };
}
