import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readGatedFile } from "./gated-read.js";
import { writeFileAtomic } from "./usage-file.js";

// Beside the sessions dir, not in it, and not `.json`: every status-line reader globs
// `sessions/*.json` and must never take this for a reading.
const BACKOFF_FILE = "usage-poll.backoff";
// The timer ticks every 150 s, so the first 429 skips at least one tick and each further
// one doubles the wait, up to an hour.
const BACKOFF_BASE_SECONDS = 300;
const BACKOFF_MAX_SECONDS = 3600;
const MAX_BACKOFF_BYTES = 256;

export interface PollBackoff {
  // Epoch seconds; no request is sent before it.
  until: number;
  strikes: number;
}

const backoffSchema = z.object({ until: z.number().int().nonnegative(), strikes: z.number().int().positive() });

const statusCacheDir = (configDir: string): string => path.join(configDir, "status-cache");

// Anything unreadable counts as no backoff, and so does a wait longer than any this module
// sets: a broken or planted file must not stop polling for good.
export function readBackoff(configDir: string, nowSeconds: number): PollBackoff | null {
  try {
    const read = readGatedFile(path.join(statusCacheDir(configDir), BACKOFF_FILE), { maxBytes: MAX_BACKOFF_BYTES });
    if (read.status !== "read") return null;
    const parsed = backoffSchema.safeParse(JSON.parse(read.bytes.toString("utf8")));
    if (!parsed.success || parsed.data.until > nowSeconds + BACKOFF_MAX_SECONDS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function nextBackoff(previous: PollBackoff | null, nowSeconds: number): PollBackoff {
  const strikes = (previous?.strikes ?? 0) + 1;
  const wait = Math.min(BACKOFF_BASE_SECONDS * 2 ** (strikes - 1), BACKOFF_MAX_SECONDS);
  return { until: nowSeconds + wait, strikes };
}

export function writeBackoff(configDir: string, backoff: PollBackoff): void {
  const dir = statusCacheDir(configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(dir, BACKOFF_FILE, `${JSON.stringify(backoff)}\n`);
}

export function clearBackoff(configDir: string): void {
  fs.rmSync(path.join(statusCacheDir(configDir), BACKOFF_FILE), { force: true });
}
