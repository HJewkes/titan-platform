import { decayedCounts, effectiveScore, isStale, nextMaturity, type StalenessOptions } from "./scoring.js";
import type { PlaybookStore } from "./store.js";
import type { Bullet, FeedbackEvent, Maturity, ScoredBullet } from "./types.js";

export function scoreBullet(bullet: Bullet, events: readonly FeedbackEvent[], now: Date): ScoredBullet {
  const counts = decayedCounts(events, now, bullet.halfLifeDays);
  const last = events[events.length - 1];
  return {
    ...bullet,
    helpfulCount: events.filter((e) => e.type === "helpful").length,
    harmfulCount: events.filter((e) => e.type === "harmful").length,
    decayedHelpful: counts.helpful,
    decayedHarmful: counts.harmful,
    effectiveScore: effectiveScore(counts, bullet.maturity),
    lastEvidenceAt: last?.at ?? bullet.createdAt,
  };
}

export interface ScoreOptions {
  includeRetired?: boolean;
}

/** Every bullet with its decayed counts and score as of `now`. One feedback query for the whole playbook. */
export function scorePlaybook(store: PlaybookStore, now: Date, options: ScoreOptions = {}): ScoredBullet[] {
  const feedback = store.feedbackByBulletId();
  return store.list(options).map((bullet) => scoreBullet(bullet, feedback.get(bullet.id) ?? [], now));
}

export interface MaturityChange {
  bulletId: string;
  from: Maturity;
  to: Maturity;
}

/** The promotion/demotion pass. A bullet that lands on `deprecated` is retired. */
export function applyMaturity(store: PlaybookStore, now: Date): MaturityChange[] {
  const changes: MaturityChange[] = [];
  for (const bullet of scorePlaybook(store, now)) {
    const to = nextMaturity(bullet.maturity, { helpful: bullet.decayedHelpful, harmful: bullet.decayedHarmful }, bullet.pinned);
    if (to === bullet.maturity) continue;
    if (to === "deprecated") store.deprecate(bullet.id, "auto-demoted below the confidence floor");
    else store.update(bullet.id, { maturity: to });
    changes.push({ bulletId: bullet.id, from: bullet.maturity, to });
  }
  return changes;
}

/** Live bullets nobody has confirmed or refuted lately: candidates for re-validation, not for removal. */
export function staleBullets(store: PlaybookStore, now: Date, options: StalenessOptions = {}): ScoredBullet[] {
  return scorePlaybook(store, now).filter((b) => !b.pinned && isStale(b.lastEvidenceAt, now, options));
}
