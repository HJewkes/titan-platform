import type { MaterialMap } from "./material-map.js";
import type { TypeProfile } from "./profile-schema.js";

/** Why a slot's structure is in the pool: it fits, its fit turns on a gap signal, or nothing fit and the profile's own order stands in. */
export type SlotBasis = "fits" | "undecided" | "fallback";

/** One spine the sampling call must write: a structure, the beat system it plays inside (if the profile binds one), and why. */
export interface AuditionSlot {
  structure: string;
  system: string | null;
  basis: SlotBasis;
}

export interface AuditionPool {
  slots: AuditionSlot[];
  /** Set when no structure both fits and is allowed: the structure the profile falls back to, and why. */
  fallback: { structure: string; reason: string } | null;
  /** Allowed structures whose fit turns on a gap, and what the pool did with each. */
  undecided: { structure: string; gaps: string[]; used: boolean }[];
}

/**
 * The 'undecided' rule (TP-4010). A structure whose fit turns on a gap signal (`elegant-idea`) never counts as a
 * candidate, because the map cannot tell whether it fits. It only tops the pool up to k, after every fitting
 * structure, and its fit score counts each gap term as half met.
 */
export const UNDECIDED_RULE = "an undecided structure is never a candidate; it only tops the pool up to k after every fitting structure, and each gap term counts half in its fit score";

/** The 0-candidate rule (TP-4010): the profile's fixed macro, or its heuristic fallback, leads the pool. */
export const FALLBACK_RULE = "with no fitting allowed structure, the profile's fixed macro (or its heuristic fallback) leads the pool, each slot under a different bound beat system";

/** The structure a profile plays when nothing fits: its fixed macro, or the fallback of its heuristic order. */
export const profileDefault = (profile: TypeProfile): string => (profile.structure.order === "fixed" ? profile.structure.macro : profile.structure.fallback);

/** The profile's own order over structures: heuristic rows first, then the fallback; a fixed profile has one. */
function profileOrder(profile: TypeProfile): string[] {
  const { structure } = profile;
  if (structure.order === "fixed") return [structure.macro];
  return [...new Set([...structure.heuristic.map((row) => row.macro), structure.fallback, ...Object.keys(structure.macros)])];
}

const byProfileOrder = (profile: TypeProfile) => {
  const order = profileOrder(profile);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
};

function fallbackReason(map: MaterialMap): string {
  const allowed = map.fits.filter((row) => row.allowed);
  const why = allowed.map((row) => `${row.structure} ${row.fit === "no" ? "does not fit" : "is undecided"}`);
  const outside = map.fits.filter((row) => row.fit === "fits" && !row.allowed).map((row) => row.structure);
  return [`0 candidates: ${why.join("; ") || "the profile allows no registered structure"}`, ...(outside.length ? [`fit but not allowed: ${outside.join(", ")}`] : [])].join("; ");
}

/** Bound beat systems per structure, handed out in turn so repeated slots of one structure differ by system. */
function systemPicker(profile: TypeProfile): (structure: string) => string | null {
  const used = new Map<string, number>();
  return (structure) => {
    const bound = profile.structure.systems.filter((binding) => binding.macro === structure).map((binding) => binding.system);
    if (bound.length === 0) return null;
    const n = used.get(structure) ?? 0;
    used.set(structure, n + 1);
    return bound[n % bound.length]!;
  };
}

/**
 * The structures the sampling call writes spines under (plan §A.3 step 2): every candidate, topped up to the
 * profile's k with undecided structures, and with the profile's default leading when no candidate exists. When the
 * pool still holds fewer than k structures it is cycled, so k spines are always sampled.
 */
export function auditionPool(map: MaterialMap, profile: TypeProfile): AuditionPool {
  const order = byProfileOrder(profile);
  const k = profile.audition.k;
  const candidates = [...map.candidates].sort(order);
  const undecidedRows = map.fits.filter((row) => row.allowed && row.fit === "undecided").sort((a, b) => order(a.structure, b.structure));
  const fallback = candidates.length === 0 ? { structure: profileDefault(profile), reason: fallbackReason(map) } : null;
  const lead: { structure: string; basis: SlotBasis }[] = fallback ? [{ structure: fallback.structure, basis: "fallback" }] : candidates.map((structure) => ({ structure, basis: "fits" }));
  const room = Math.max(0, k - lead.length);
  const topUp = undecidedRows.filter((row) => row.structure !== fallback?.structure).slice(0, room);
  const distinct = [...lead, ...topUp.map((row) => ({ structure: row.structure, basis: "undecided" as const }))];
  const pick = systemPicker(profile);
  const slots = Array.from({ length: Math.max(k, distinct.length) }, (_, i) => distinct[i % distinct.length]!).map((s) => ({ ...s, system: pick(s.structure) }));
  const undecided = undecidedRows.map((row) => ({
    structure: row.structure, gaps: map.gaps.filter((gap) => row.reasons.some((r) => r.includes(`${gap} is a gap`))), used: topUp.includes(row),
  }));
  return { slots, fallback, undecided };
}
