import type { ChurnWindow } from "./history/index.js";
import type { GraphMetric } from "./types.js";

const DAY_SECONDS = 86400;

/** Metric-name suffix for a window: `30d`, `180d`, or `lifetime`. */
export function windowSuffix(window: ChurnWindow): string {
  return window === "lifetime" ? "lifetime" : `${window}d`;
}

/**
 * Age-discount metrics: `recency_{w}` = min(1, age/w) for each file that churned
 * in window `w`, plus one window-independent `file_age_days` per file. Multiplying
 * a hotspot score by recency stops a young file's burst of churn from reading as
 * decay. Recency is emitted (as 1) even when the age is unknown, so a rule that
 * needs every hotspot factor is never silently disabled; `file_age_days` only when known.
 */
export function computeRecencyWindows(
  firstSeen: ReadonlyMap<string, number>,
  churnedIdsByWindow: ReadonlyMap<ChurnWindow, ReadonlySet<string>>,
  nowEpoch: number,
): GraphMetric[] {
  const out: GraphMetric[] = [];
  const ageEmitted = new Set<string>();
  for (const [windowDays, ids] of churnedIdsByWindow) {
    const suffix = windowSuffix(windowDays);
    for (const id of ids) {
      const seen = firstSeen.get(id);
      let recency = 1;
      if (seen !== undefined) {
        const ageDays = Math.max(0, (nowEpoch - seen) / DAY_SECONDS);
        // Lifetime has no window to age against, so its recency stays 1.
        if (windowDays !== "lifetime") recency = Math.min(1, ageDays / windowDays);
        if (!ageEmitted.has(id)) {
          out.push({ nodeId: id, name: "file_age_days", value: Math.round(ageDays), unit: "days" });
          ageEmitted.add(id);
        }
      }
      out.push({ nodeId: id, name: `recency_${suffix}`, value: round3(recency), unit: "ratio" });
    }
  }
  return out;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
