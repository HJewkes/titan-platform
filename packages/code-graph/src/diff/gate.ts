import type { SnapshotRow } from "../types.js";
import { symbolSetHash, type FootprintUnit, type SymbolFootprint } from "./footprint.js";

/**
 * What a consumer generated a unit's doc from. Provenance lives with the consumer, not the
 * store, so it survives snapshot prune.
 */
export interface UnitProvenance {
  unitId: string;
  /** The to-snapshot's commit hash; null for a working-tree snapshot. */
  commit: string | null;
  symbolSetHash: string;
  /** The generator the consumer used; the gate records it but never calls one. */
  model: string | null;
}

export interface UnitProvenanceInput {
  unit: FootprintUnit;
  footprints: ReadonlyMap<string, SymbolFootprint>;
  snapshot: Pick<SnapshotRow, "commitHash">;
  model?: string | null;
}

export type RegenerateReason = "new" | "changed";

export interface UnitRegeneration {
  unitId: string;
  reason: RegenerateReason;
}

export interface GateUnitsInput {
  prior: readonly UnitProvenance[];
  units: readonly FootprintUnit[];
  footprints: ReadonlyMap<string, SymbolFootprint>;
}

/** An empty `regenerate` means the caller makes no LLM call. */
export interface GateResult {
  regenerate: UnitRegeneration[];
  skip: string[];
  /** Prior units that no longer exist. */
  orphaned: string[];
}

/** A fresh provenance record for one unit at the given snapshot. */
export function unitProvenance(input: UnitProvenanceInput): UnitProvenance {
  return {
    unitId: input.unit.unitId,
    commit: input.snapshot.commitHash,
    symbolSetHash: symbolSetHash(input.unit, input.footprints),
    model: input.model ?? null,
  };
}

/** Splits units into those whose symbol-set hash moved since the prior record and those that did not. */
export function gateUnits(input: GateUnitsInput): GateResult {
  const priorHash = new Map(input.prior.map((p) => [p.unitId, p.symbolSetHash]));
  const current = new Set(input.units.map((u) => u.unitId));
  const regenerate: UnitRegeneration[] = [];
  const skip: string[] = [];
  for (const unit of input.units) {
    const before = priorHash.get(unit.unitId);
    if (before === undefined) regenerate.push({ unitId: unit.unitId, reason: "new" });
    else if (before !== symbolSetHash(unit, input.footprints)) regenerate.push({ unitId: unit.unitId, reason: "changed" });
    else skip.push(unit.unitId);
  }
  const orphaned = [...priorHash.keys()].filter((id) => !current.has(id));
  return { regenerate, skip, orphaned };
}
