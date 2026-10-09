import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../redact.js";
import { POLL_SESSION_ID, parseUsageReading, type UsageReading } from "../usage.js";
import { redactedError } from "./redact-error.js";

export const USAGE_FILE = `${POLL_SESSION_ID}.json`;
export const MAX_READING_BYTES = 256 * 1024;

export interface UsageFileRead {
  reading: UsageReading;
  file: string;
  ageSeconds: number;
}

export function sessionsDir(configDir: string): string {
  return path.join(configDir, "status-cache", "sessions");
}

export function usageFilePath(configDir: string): string {
  return path.join(sessionsDir(configDir), USAGE_FILE);
}

function listReadingFiles(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The status line prunes its files while this runs, and any one file may be half-written
// by another writer, so a file that cannot be read is skipped rather than fatal.
function readReadingFile(file: string): UsageReading | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_READING_BYTES) return null;
    const reading = parseUsageReading(JSON.parse(fs.readFileSync(file, "utf8")));
    return reading !== null && Object.keys(reading.rate_limits).length > 0 ? reading : null;
  } catch {
    return null;
  }
}

function newestReading(dir: string, names: string[]): { reading: UsageReading; file: string } | null {
  let newest: { reading: UsageReading; file: string } | null = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const reading = readReadingFile(file);
    if (reading !== null && (newest === null || reading.written_at > newest.reading.written_at)) {
      newest = { reading, file };
    }
  }
  return newest;
}

// The newest reading with at least one window across every file in the sessions dir: the
// poller's and each status-line session's, since all describe the same account.
export function readUsage(configDir: string, options: { now?: number } = {}): UsageFileRead | null {
  try {
    const dir = sessionsDir(configDir);
    const names = listReadingFiles(dir);
    const newest = names === null ? null : newestReading(dir, names);
    if (newest === null) return null;
    const ageSeconds = Math.max(0, Math.floor((options.now ?? Date.now()) / 1000) - newest.reading.written_at);
    return { ...newest, ageSeconds };
  } catch (error) {
    throw redactedError(error, "reading usage failed");
  }
}

function writeSynced(file: string, text: string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Best effort: some platforms cannot open or fsync a directory, and the rename has already
// made the new file whole; this only makes the rename itself durable.
function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
}

// The temp name ends in `.tmp`, not `.json`, so no reader of the dir picks up a partial file.
function writeAtomic(dir: string, target: string, text: string): void {
  const temp = path.join(dir, `.${USAGE_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeSynced(temp, text);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  syncDir(dir);
}

function serialize(reading: UsageReading): string {
  const valid = parseUsageReading(reading);
  if (valid === null || valid.session_id !== POLL_SESSION_ID) {
    throw new TypeError(`writeReading needs a valid reading with session_id ${POLL_SESSION_ID}`);
  }
  const text = `${JSON.stringify(valid)}\n`;
  if (redactSecrets(text) !== text) throw new TypeError("writeReading refused a token-shaped value");
  return text;
}

// Replaces `<configDir>/status-cache/sessions/usage-poll.json` atomically with mode 0600:
// a reader sees the old reading or the new one, never a partial file. Only the fields
// parseUsageReading keeps are written. Returns the file's path.
export function writeReading(configDir: string, reading: UsageReading): string {
  const text = serialize(reading);
  const dir = sessionsDir(configDir);
  const target = path.join(dir, USAGE_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(dir, target, text);
  } catch (error) {
    throw redactedError(error, "writing the usage reading failed");
  }
  return target;
}
