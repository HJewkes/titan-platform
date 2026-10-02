import { unitHash, variantHash } from "./hash.js";
import { TRIAL_SCHEMA_VERSION } from "./spec/trial.js";
import type { Scorecard, TrialRecord, UnitSpec, VariantSpec } from "./spec/index.js";

export type UnitRef = VariantSpec["unit"];

/** Returns the variant that holds a unit's champion slot right now. */
export type ChampionOf = (unit: UnitRef) => VariantSpec | Promise<VariantSpec>;

export interface TrialStart {
  unit: UnitSpec;
  /** A variant spec, or "champion" for whichever variant holds the unit's champion slot. */
  variant: VariantSpec | "champion";
  caseHash: string;
  startedAt: string;
  championOf: ChampionOf;
}

/** Resolves every "champion" when the trial starts, so a later change of champion cannot re-key it. */
export async function startTrial(start: TrialStart): Promise<TrialRecord> {
  const unit = { id: start.unit.id, version: start.unit.version };
  const variant = start.variant === "champion" ? await start.championOf(unit) : start.variant;
  const champions = await resolveChildChampions(variant, start.championOf, "", new Set([refKey(unit)]));
  return {
    schema: TRIAL_SCHEMA_VERSION,
    unit: unitHash(start.unit),
    variant: variantHash(variant),
    case: start.caseHash,
    startedAt: start.startedAt,
    champions: Object.keys(champions).length > 0 ? champions : undefined,
  };
}

async function resolveChildChampions(
  variant: VariantSpec,
  championOf: ChampionOf,
  prefix: string,
  ancestors: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [stepId, step] of Object.entries(variant.steps)) {
    if (step.kind !== "unit" || step.variant !== "champion") continue;
    const path = `${prefix}${stepId}`;
    const key = refKey(step.unit);
    if (ancestors.has(key)) throw new Error(`champion cycle at step ${path}: ${key} already runs above it`);
    const child = await championOf(step.unit);
    resolved[path] = variantHash(child);
    Object.assign(resolved, await resolveChildChampions(child, championOf, `${path}/`, new Set([...ancestors, key])));
  }
  return resolved;
}

function refKey(unit: UnitRef): string {
  return `${unit.id}@${unit.version}`;
}

/** The scorecard key a trial scores under; its resolved champions keep two champions apart. */
export function scorecardKeysFor(trial: TrialRecord, rest: Omit<Scorecard["keys"], "unit" | "variant" | "champions">): Scorecard["keys"] {
  return { unit: trial.unit, variant: trial.variant, champions: trial.champions, ...rest };
}
