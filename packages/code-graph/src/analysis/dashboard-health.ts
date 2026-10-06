/**
 * Composite dashboard health score. Extracted from dashboard-payload.ts (which
 * sits over the max-file-loc budget) so that file stays lean as new payload
 * slices land.
 */

export type HealthComponentKey = "hotspots" | "findings" | "complexity" | "hidden-coupling";

export interface HealthComponent {
  key: HealthComponentKey;
  label: string;
  penalty: number;
  /** The most this component can take off the score. */
  cap: number;
  detail: string;
}

/** Points per counted item, and the most one component can take. */
export interface PenaltyWeight {
  each: number;
  cap: number;
}

export interface HealthWeights {
  hotspots: PenaltyWeight;
  findings: { eachNew: number; eachCarry: number; cap: number };
  /** `each` point per unit of max complexity over `budget`. */
  complexity: PenaltyWeight & { budget: number };
  hiddenCoupling: PenaltyWeight;
}

export const DEFAULT_HEALTH_WEIGHTS: HealthWeights = {
  hotspots: { each: 10, cap: 30 },
  findings: { eachNew: 8, eachCarry: 3, cap: 20 },
  complexity: { each: 1, budget: 30, cap: 15 },
  hiddenCoupling: { each: 2, cap: 10 },
};

export interface HealthInput {
  scary: number;
  newViolations: number;
  carryViolations: number;
  maxComplexity: number;
  hiddenCoupling: number;
  /** The hotspot score `scary` counted files at; only the detail text reads it. */
  scaryCutoff?: number;
}

function healthComponents(x: HealthInput, w: HealthWeights): HealthComponent[] {
  const over = Math.max(0, x.maxComplexity - w.complexity.budget);
  return [
    { key: "hotspots", label: "scary hotspots", penalty: Math.min(w.hotspots.cap, x.scary * w.hotspots.each), cap: w.hotspots.cap, detail: `${x.scary} file(s) ≥ ${x.scaryCutoff ?? 3000}` },
    {
      key: "findings",
      label: "fitness violations",
      penalty: Math.min(w.findings.cap, x.newViolations * w.findings.eachNew + x.carryViolations * w.findings.eachCarry),
      cap: w.findings.cap,
      detail: `${x.newViolations} new, ${x.carryViolations} parked (non-hotspot rules)`,
    },
    { key: "complexity", label: "complexity over budget", penalty: Math.min(w.complexity.cap, over * w.complexity.each), cap: w.complexity.cap, detail: `max ${x.maxComplexity} vs budget ${w.complexity.budget}` },
    { key: "hidden-coupling", label: "hidden coupling", penalty: Math.min(w.hiddenCoupling.cap, x.hiddenCoupling * w.hiddenCoupling.each), cap: w.hiddenCoupling.cap, detail: `${x.hiddenCoupling} pair(s) co-change without an import` },
  ];
}

/**
 * Composite health as a transparent sum of independent penalty components, so
 * the UI can show *why* the score is what it is instead of a black-box number.
 * Each component is capped and drawn from a distinct dimension — the hotspots
 * component owns scary files, so the violations component excludes the
 * scary-hotspots rule (no double-count). Ownership (knowledge-silo / bus-factor)
 * signal is deliberately NOT a health component: it saturates on single-author
 * repos and lives on the Ownership tab, not in the cross-cutting score.
 * `weights` defaults to the dashboard's; a caller may weigh the components its own way.
 */
export function computeHealth(
  x: HealthInput,
  weights: HealthWeights = DEFAULT_HEALTH_WEIGHTS,
): { health: number; healthBreakdown: HealthComponent[] } {
  const breakdown = healthComponents(x, weights);
  const total = breakdown.reduce((s, c) => s + c.penalty, 0);
  return { health: Math.max(0, 100 - total), healthBreakdown: breakdown };
}
