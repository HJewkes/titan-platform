import type { TypeProfile } from "./profile-schema.js";

/** What the material map says about one video's material: the signals that hold, and the planned runtime. */
export interface MaterialSignals {
  signals: ReadonlySet<string>;
  runtimeS?: number;
}

export interface ChapterOrder {
  macro: string;
  /** The heuristic signal that picked the macro; absent for a fixed order or the fallback. */
  signal?: string;
  blocks: string[];
}

/**
 * The chapter order a profile gives one video. A fixed structure ignores the material. A
 * heuristic one asks its rows in order and stops at the first yes (story-structure §4); a row
 * with `minRuntimeS` holds only at that runtime or longer. No yes means the fallback macro.
 */
export function chapterOrder(profile: TypeProfile, material: MaterialSignals): ChapterOrder {
  const { structure } = profile;
  if (structure.order === "fixed") return { macro: structure.macro, blocks: structure.blocks.map((block) => block.id) };
  const runtimeS = material.runtimeS ?? profile.runtime.targetS;
  const row = structure.heuristic.find((candidate) => material.signals.has(candidate.signal) && runtimeS >= (candidate.minRuntimeS ?? 0));
  const macro = row?.macro ?? structure.fallback;
  return { macro, ...(row ? { signal: row.signal } : {}), blocks: [...(structure.macros[macro] ?? [])] };
}
