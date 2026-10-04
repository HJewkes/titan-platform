/**
 * Composite dashboard health score. Extracted from dashboard-payload.ts (which
 * sits over the max-file-loc budget) so that file stays lean as new payload
 * slices land.
 */

export interface HealthComponent {
  label: string;
  penalty: number;
  detail: string;
}

/**
 * Composite health as a transparent sum of independent penalty components, so
 * the UI can show *why* the score is what it is instead of a black-box number.
 * Each component is capped and drawn from a distinct dimension — the hotspots
 * component owns scary files, so the violations component excludes the
 * scary-hotspots rule (no double-count). Ownership (knowledge-silo / bus-factor)
 * signal is deliberately NOT a health component: it saturates on single-author
 * repos and lives on the Ownership tab, not in the cross-cutting score.
 */
export function computeHealth(x: {
  scary: number;
  newViolations: number;
  carryViolations: number;
  maxComplexity: number;
  hiddenCoupling: number;
}): { health: number; healthBreakdown: HealthComponent[] } {
  const breakdown: HealthComponent[] = [
    { label: "scary hotspots", penalty: Math.min(30, x.scary * 10), detail: `${x.scary} file(s) ≥ 3000` },
    { label: "fitness violations", penalty: Math.min(20, x.newViolations * 8 + x.carryViolations * 3), detail: `${x.newViolations} new, ${x.carryViolations} parked (non-hotspot rules)` },
    { label: "complexity over budget", penalty: Math.min(15, Math.max(0, x.maxComplexity - 30)), detail: `max ${x.maxComplexity} vs budget 30` },
    { label: "hidden coupling", penalty: Math.min(10, x.hiddenCoupling * 2), detail: `${x.hiddenCoupling} pair(s) co-change without an import` },
  ];
  const total = breakdown.reduce((s, c) => s + c.penalty, 0);
  return { health: Math.max(0, 100 - total), healthBreakdown: breakdown };
}
