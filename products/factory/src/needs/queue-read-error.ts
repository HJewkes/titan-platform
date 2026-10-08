export type QueueReadFailure = "not-running" | "unreachable" | "unauthorized" | "http" | "malformed";

/** A source that cannot be read throws this, so a caller never mistakes an outage for an empty queue. */
export class QueueReadError extends Error {
  constructor(
    readonly source: string,
    readonly failure: QueueReadFailure,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = "QueueReadError";
  }
}

const SUMMARY_MAX = 280;

/** The first non-blank line, cut to the schema's 280 characters; `fallback` when the text has none. */
export function summaryOf(text: string, fallback: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? fallback;
  return line.length <= SUMMARY_MAX ? line : `${line.slice(0, SUMMARY_MAX - 1)}…`;
}
