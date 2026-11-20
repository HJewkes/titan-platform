const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A log or countdown time in the reader's own zone, short enough for one phone line. */
export function logTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : TIME.format(ms);
}

/** The inbox line for an item the by-rec sweep will answer; in shadow it only logs, so it says "would". */
export function byRecLine({ at, mode }: { at: string; mode: "shadow" | "live" }): string {
  return mode === "live" ? `Goes with rec at ${logTime(at)}` : `Would go with rec at ${logTime(at)} (shadow)`;
}
