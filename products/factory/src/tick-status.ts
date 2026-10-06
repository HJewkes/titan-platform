import { errorClass } from "./shepherd/error-class.js";

/** Where the burndown tick's status file was looked for, and its text when one exists there. */
export interface TickStatusRead {
  file: string;
  text: string | undefined;
}

interface TickProblem {
  cause: "tick failing" | "tick stale";
  message: string;
  detail: Record<string, string | number | null>;
}

/** A heartbeat older than this many intervals means the tick no longer runs. */
const STALE_INTERVALS = 3;

interface Parsed {
  heartbeatAt: number;
  intervalSeconds: number;
  consecutiveFailures: number;
  lastErrorClass: string | undefined;
}

function parse(text: string): Parsed | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return undefined;
    const p = raw as Record<string, unknown>;
    const heartbeatAt = typeof p.heartbeatAt === "string" ? Date.parse(p.heartbeatAt) : Number.NaN;
    const interval = p.intervalSeconds;
    if (p.version !== 1 || Number.isNaN(heartbeatAt) || typeof interval !== "number" || !(interval > 0)) return undefined;
    const count = p.consecutiveFailures;
    return {
      heartbeatAt,
      intervalSeconds: interval,
      consecutiveFailures: typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0,
      lastErrorClass: typeof p.lastErrorClass === "string" ? p.lastErrorClass : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Only a class that passes the shared identifier and credential guard is echoed; anything else reads as the generic `Error`. */
function safeClass(value: string | undefined): string | null {
  return value === undefined ? null : errorClass(Object.assign(new Error(), { name: value }));
}

/** An absent or unreadable file is no problem: an owner without burndown installed must not fail the check. */
export function judgeTick(read: TickStatusRead, nowMs: number): TickProblem | undefined {
  const status = read.text === undefined ? undefined : parse(read.text);
  if (status === undefined) return undefined;
  const ageMs = nowMs - status.heartbeatAt;
  if (ageMs > STALE_INTERVALS * status.intervalSeconds * 1000) {
    const message = `the burndown tick last reported ${Math.round(ageMs / 60_000)} minutes ago, over ${STALE_INTERVALS} intervals of ${status.intervalSeconds}s; see ${read.file}`;
    return { cause: "tick stale", message, detail: { tickFile: read.file, tickAgeSeconds: Math.round(ageMs / 1000), tickIntervalSeconds: status.intervalSeconds } };
  }
  if (status.consecutiveFailures < 1) return undefined;
  const errorClassName = safeClass(status.lastErrorClass);
  const named = errorClassName === null ? "" : ` (${errorClassName})`;
  const message = `the burndown tick has failed ${status.consecutiveFailures} times in a row${named}; see ${read.file}`;
  return { cause: "tick failing", message, detail: { tickFile: read.file, tickFailures: status.consecutiveFailures, tickErrorClass: errorClassName } };
}
