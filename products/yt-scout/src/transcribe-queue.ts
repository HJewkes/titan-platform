import type { Db } from "@titan-design/store-sqlite";
import { isOpen, reset, trip, type BreakerStore } from "./breaker.js";
import { transcribeVideo, type TranscribeEnv } from "./transcribe.js";
import type { StepErrorClass } from "./seams.js";
import type { VideoRow } from "./store.js";

const HOUR = 3_600_000;
export const MAX_ATTEMPTS = 5;
export const CAPTION_WAIT_MS = 24 * HOUR;
export const CAPTION_RETRY_MS = 6 * HOUR;
export const LIVE_GIVE_UP_MS = 48 * HOUR;
export const WHISPER_PER_TICK = 2;
export const WHISPER_MAX_LOAD = 12;
const OTHER_RETRY_MS = HOUR;

export interface QueueEnv extends TranscribeEnv {
  now: () => Date;
  /** The 5-minute load average. */
  load5: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 0 to 1; spreads the gap between videos. */
  random: () => number;
  breaker: BreakerStore;
}

export interface QueueReport {
  transcribed: string[];
  rescheduled: string[];
  failed: string[];
  whisperRefused: string[];
  breakerOpen: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function update(db: Db, id: string, fields: { state?: string; attempts?: number; next_retry_at?: string | null; last_error_class?: string | null }): void {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE videos SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), id);
}

const ageMs = (v: VideoRow, now: Date): number => now.getTime() - Date.parse(v.published ?? v.detected_at);

function dueVideos(db: Db, now: Date, whisper: boolean): VideoRow[] {
  const waiting = whisper ? "last_error_class = 'no_captions' AND next_retry_at IS NULL" : "last_error_class IS NOT 'no_captions' OR next_retry_at IS NOT NULL";
  return db
    .prepare<[string], VideoRow>(
      `SELECT * FROM videos WHERE state = 'new' AND (next_retry_at IS NULL OR next_retry_at <= ?) AND (${waiting}) ORDER BY detected_at`,
    )
    .all(now.toISOString());
}

/** Where a failed attempt leaves the video (plan section 3, failures and retries). */
function scheduleFailure(db: Db, env: QueueEnv, v: VideoRow, errorClass: StepErrorClass, report: QueueReport): void {
  const now = env.now();
  const attempts = v.attempts + 1;
  const base = { attempts, last_error_class: errorClass };
  if (errorClass === "live" || errorClass === "upcoming") {
    const stale = now.getTime() - Date.parse(v.detected_at) >= LIVE_GIVE_UP_MS;
    update(db, v.id, stale ? { ...base, state: "failed:live", next_retry_at: null } : { ...base, next_retry_at: iso(now.getTime() + CAPTION_RETRY_MS) });
    (stale ? report.failed : report.rescheduled).push(v.id);
  } else if (attempts >= MAX_ATTEMPTS) {
    update(db, v.id, { ...base, state: "failed", next_retry_at: null });
    report.failed.push(v.id);
  } else if (errorClass === "no_captions") {
    // Auto-captions often land hours after upload; past 24 h the video waits for the Whisper queue.
    const young = ageMs(v, now) < CAPTION_WAIT_MS;
    update(db, v.id, { ...base, next_retry_at: young ? iso(now.getTime() + CAPTION_RETRY_MS) : null });
    report.rescheduled.push(v.id);
  } else {
    update(db, v.id, { ...base, next_retry_at: iso(now.getTime() + OTHER_RETRY_MS) });
    report.rescheduled.push(v.id);
  }
}

function openBreaker(db: Db, env: QueueEnv, v: VideoRow, report: QueueReport): void {
  const next = trip(env.breaker.read(), env.now());
  env.breaker.write(next);
  // A throttle is not the video's fault, so it does not spend an attempt.
  update(db, v.id, { last_error_class: "http429", next_retry_at: next.openUntil });
  report.rescheduled.push(v.id);
  report.breakerOpen = true;
}

async function subtitlePhase(db: Db, env: QueueEnv, report: QueueReport): Promise<void> {
  const queue = dueVideos(db, env.now(), false);
  for (const [i, v] of queue.entries()) {
    if (isOpen(env.breaker.read(), env.now())) {
      report.breakerOpen = true;
      return;
    }
    if (i > 0) await env.sleep(6000 + (env.random() - 0.5) * 6000);
    const out = await transcribeVideo(env, v.id, "subtitles");
    if (out.ok) {
      update(db, v.id, { state: "transcribed", attempts: v.attempts + 1, next_retry_at: null, last_error_class: null });
      env.breaker.write(reset());
      report.transcribed.push(v.id);
    } else if (out.errorClass === "http429") {
      openBreaker(db, env, v, report);
      return;
    } else {
      scheduleFailure(db, env, v, out.errorClass, report);
    }
  }
}

async function whisperPhase(db: Db, env: QueueEnv, report: QueueReport): Promise<void> {
  // Never turn a throttle into CPU load.
  if (report.breakerOpen) return;
  let ran = 0;
  for (const v of dueVideos(db, env.now(), true)) {
    if (ran >= WHISPER_PER_TICK) return;
    if (env.load5() >= WHISPER_MAX_LOAD) {
      report.whisperRefused.push(v.id);
      continue;
    }
    ran++;
    const out = await transcribeVideo(env, v.id, "whisper");
    if (out.ok) {
      update(db, v.id, { state: "transcribed", attempts: v.attempts + 1, next_retry_at: null, last_error_class: null });
      report.transcribed.push(v.id);
    } else {
      scheduleFailure(db, env, v, out.errorClass === "no_captions" ? "other" : out.errorClass, report);
    }
  }
}

export async function runTranscribeQueue(db: Db, env: QueueEnv): Promise<QueueReport> {
  const report: QueueReport = { transcribed: [], rescheduled: [], failed: [], whisperRefused: [], breakerOpen: false };
  await subtitlePhase(db, env, report);
  await whisperPhase(db, env, report);
  return report;
}
