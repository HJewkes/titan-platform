import type { MeasurementAudit, MetricSpec } from "@titan-design/health/metrics";
import type { Baseline, SliceProposal, SurfaceRef } from "./schemas.js";

type Captured = MetricSpec["source"]["captured"];
type Family = MetricSpec["family"];
export type RankedGap = MeasurementAudit["gaps"][number];

/** Owner load first: item 95 makes the owner's waiting the one place every system reports to. */
const FAMILY_WEIGHT: Record<Family, number> = { "owner-load": 3, availability: 2, flow: 2, quality: 2, cost: 1, business: 1 };

/** A Y claim stands only on a baseline with data; the step never promotes P or N on a number alone. */
export function classify(metric: MetricSpec, baseline: Baseline | undefined): Captured {
  const claimed = metric.source.captured;
  if (claimed !== "Y") return claimed;
  return baseline && baseline.error === undefined && baseline.n > 0 ? "Y" : "P";
}

/** A command is tried only when it is a declared cli surface, alone or followed by its own flags. */
export function isDeclaredSurface(command: string, surfaces: readonly SurfaceRef[]): boolean {
  return surfaces.some((surface) => surface.kind === "cli" && (command === surface.ref || command.startsWith(`${surface.ref} `)));
}

function score(slice: SliceProposal, families: ReadonlyMap<string, Family>): number {
  const weight = Math.max(1, ...slice.metrics.map((id) => FAMILY_WEIGHT[families.get(id) ?? "business"]));
  return (Math.max(1, slice.unblocks.length) * weight) / slice.estimate;
}

/** Ranks by (questions unblocked x family weight) / estimate; the registry entry always comes last. */
export function rankSlices(system: string, slices: readonly SliceProposal[], metrics: readonly MetricSpec[]): RankedGap[] {
  const families = new Map(metrics.map((metric) => [metric.id, metric.family]));
  const ranked = slices.map((slice) => ({ slice, score: score(slice, families) })).sort((a, b) => b.score - a.score);
  const gaps = ranked.map(({ slice }) => ({ metric: slice.metrics, slice: { title: slice.title, done_when: slice.done_when, estimate: slice.estimate } }));
  gaps.push({ metric: [], slice: registrySlice(system) });
  return gaps.map((gap, index) => ({ rank: index + 1, ...gap }));
}

function registrySlice(system: string): RankedGap["slice"] {
  return { title: `metrics/${system}.yml registry entry`, done_when: `metrics/${system}.yml holds every metric of this audit and passes validateEntry`, estimate: 2 };
}
