import type { DetectedVideo } from "./seams.js";
import type { VideoState } from "./store.js";

export const LIVE_RECHECK_MS = 6 * 3600_000;

export interface FilterLimits {
  min_seconds: number;
  max_seconds: number;
}

export interface Disposition {
  state: VideoState;
  next_retry_at: string | null;
}

/** Plan section 3, step 2: shorts are skipped, live and upcoming wait six hours, over-long VODs are indexed only. */
export function dispositionOf(video: DetectedVideo, limits: FilterLimits, now: Date): Disposition {
  if (video.kind === "short" || (video.duration !== undefined && video.duration < limits.min_seconds)) {
    return { state: "skipped:short", next_retry_at: null };
  }
  if (video.kind === "live" || video.kind === "upcoming") {
    return { state: "new", next_retry_at: new Date(now.getTime() + LIVE_RECHECK_MS).toISOString() };
  }
  if (video.duration !== undefined && video.duration > limits.max_seconds) return { state: "index_only", next_retry_at: null };
  return { state: "new", next_retry_at: null };
}
