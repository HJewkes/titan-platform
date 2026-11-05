import { structureFor } from "./profile-load.js";
import type { TypeProfile } from "./profile-schema.js";
import { fits, type NarrativeStructure } from "./structure-schema.js";

/** What the material map says about one video's material: the signals that hold, and the planned runtime. */
export interface MaterialSignals {
  signals: ReadonlySet<string>;
  runtimeS?: number;
}

export interface ChapterOrder {
  macro: string;
  /** True when no heuristic row's structure fit, so the profile's fallback was taken. */
  fallback: boolean;
  blocks: string[];
}

/**
 * The chapter order a profile gives one video. A fixed structure ignores the material. A
 * heuristic one asks its rows in order and stops at the first whose registered structure fits
 * (story-structure §4); an unregistered structure throws. No fit means the fallback macro.
 */
export function chapterOrder(profile: TypeProfile, material: MaterialSignals, structures: ReadonlyMap<string, NarrativeStructure>): ChapterOrder {
  const { structure } = profile;
  if (structure.order === "fixed") return { macro: structure.macro, fallback: false, blocks: structure.blocks.map((block) => block.id) };
  const input = { signals: material.signals, runtimeS: material.runtimeS ?? profile.runtime.targetS };
  const row = structure.heuristic.find((candidate) => fits(structureFor(structures, candidate.macro), input));
  const macro = row?.macro ?? structure.fallback;
  return { macro, fallback: row === undefined, blocks: [...(structure.macros[macro] ?? [])] };
}
