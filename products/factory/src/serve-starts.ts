import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Kept beside the daemon pid file, so each state directory, and so each serve, counts its own starts. */
const SERVE_STARTS_FILE = "serve-starts.json";

interface StartsFile {
  starts: number;
  uncleanStarts: number;
  /** The UTC day of the last start, as YYYY-MM-DD. */
  day: string;
  startsOnDay: number;
}

export interface ServeStart {
  startedAt: string;
  /** Every start recorded in this state directory, this one included. */
  restartCount: number;
  /** Starts that found a stale daemon pid file: the previous serve exited without cleaning up. */
  uncleanStartsTotal: number;
  restartsToday: number;
}

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function readStarts(path: string): StartsFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StartsFile>;
    const valid = isCount(parsed.starts) && isCount(parsed.uncleanStarts) && isCount(parsed.startsOnDay) && typeof parsed.day === "string";
    return valid ? (parsed as StartsFile) : undefined;
  } catch {
    return undefined;
  }
}

/** Called once per successful serve start; a missing or unreadable file starts the counts over rather than failing the start. */
export function recordServeStart(stateDir: string, { unclean, now }: { unclean: boolean; now: Date }): ServeStart {
  const path = join(stateDir, SERVE_STARTS_FILE);
  const previous = readStarts(path);
  const day = utcDay(now);
  const next: StartsFile = {
    starts: (previous?.starts ?? 0) + 1,
    uncleanStarts: (previous?.uncleanStarts ?? 0) + (unclean ? 1 : 0),
    day,
    startsOnDay: (previous?.day === day ? previous.startsOnDay : 0) + 1,
  };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next)}\n`);
  renameSync(`${path}.tmp`, path);
  return { startedAt: now.toISOString(), restartCount: next.starts, uncleanStartsTotal: next.uncleanStarts, restartsToday: next.startsOnDay };
}

/** `restartsToday` reads 0 once the UTC day has turned since this serve started. */
export function serveStartsHealth(start: ServeStart, now: Date): ServeStart & { uptimeSeconds: number } {
  const sameDay = start.startedAt.slice(0, 10) === utcDay(now);
  return {
    startedAt: start.startedAt,
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(start.startedAt)) / 1000)),
    restartCount: start.restartCount,
    uncleanStartsTotal: start.uncleanStartsTotal,
    restartsToday: sameDay ? start.restartsToday : 0,
  };
}
