import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { usageFromRolloutEvents, type UsageResult } from "../usage.js";
import type { AccountProfile } from "../profile.js";
import { validateProfile } from "./profile.js";

export interface ReadUsageOptions {
  /** Total bytes across all rollouts; exceeding the bound gives unknown, never a partial reading. */
  maxBytes?: number;
  maxFiles?: number;
}
interface Bounds { bytes: number; files: number; entries: number }

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function directoryFiles(dir: string, bounds: Bounds, depth = 0): Promise<string[]> {
  if (depth > 8) throw new Error("rollout depth limit");
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a rollout directory");
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (--bounds.entries < 0 || entry.isSymbolicLink()) throw new Error("unsafe rollout entry");
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(path, bounds, depth + 1));
    else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
      if (--bounds.files < 0 || !entry.isFile()) throw new Error("rollout file limit");
      files.push(path);
    }
  }
  return files;
}

async function collectFiles(codeHome: string, bounds: Bounds): Promise<string[]> {
  const files: string[] = [];
  for (const name of ["sessions", "archived_sessions"]) {
    const dir = join(codeHome, name);
    try { await lstat(dir); }
    catch (error) { if (missing(error)) continue; throw error; }
    files.push(...await directoryFiles(dir, bounds));
  }
  return files;
}

async function fileEvents(file: string, root: string, bounds: Bounds): Promise<unknown[]> {
  const actual = await realpath(file);
  const rel = relative(root, actual);
  if (rel.startsWith(`..${sep}`) || rel === ".." || !/^(sessions|archived_sessions)[/\\]/.test(rel)) throw new Error("outside rollout root");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > bounds.bytes) throw new Error("unsafe rollout file");
    bounds.bytes -= stat.size;
    // Fixed-length read also bounds a concurrently growing file. A size change refuses the snapshot.
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) throw new Error("rollout changed during read");
    return eventsFromText(buffer.toString("utf8"));
  } finally { await handle.close(); }
}

function eventsFromText(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event: unknown = JSON.parse(line);
    if (typeof event === "object" && event !== null && "type" in event && event.type === "event_msg") events.push(event);
  }
  return events;
}

/** Read active and archived rollout JSONL only, never auth.json; any scan failure refuses. */
export async function readUsage(profile: AccountProfile, options: ReadUsageOptions = {}): Promise<UsageResult> {
  validateProfile(profile);
  const bounds = { bytes: options.maxBytes ?? 64 * 1024 * 1024, files: options.maxFiles ?? 4096, entries: 16384 };
  if (![bounds.bytes, bounds.files].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("read bounds must be positive integers");
  try {
    const root = await realpath(profile.codeHome);
    const files = await collectFiles(profile.codeHome, bounds);
    const events: unknown[] = [];
    for (const file of files) events.push(...await fileEvents(file, root, bounds));
    return usageFromRolloutEvents(events, profile.label);
  } catch { return { status: "unknown", reason: "unreadable" }; }
}
