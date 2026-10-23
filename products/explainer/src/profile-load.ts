import { loadBeatSystems } from "./beat-system-load.js";
import type { BeatSystem } from "./beat-system-schema.js";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { AudiencePackSchema, TypeProfileSchema, type AudiencePack, type TypeProfile } from "./profile-schema.js";
import { loadStylePacks } from "./style-pack-load.js";
import type { StylePack } from "./style-pack-schema.js";
import { NarrativeStructureSchema, type NarrativeStructure } from "./structure-schema.js";
import { readYamlDir } from "./yaml-dir.js";

/** `explain-repo` makes a tour unless asked otherwise (decision 326.1). */
export const EXPLAIN_REPO_DEFAULT_TYPE = "repo-tour" as const;

export interface ProfileSet {
  profiles: ReadonlyMap<string, TypeProfile>;
  audiences: ReadonlyMap<string, AudiencePack>;
  structures: ReadonlyMap<string, NarrativeStructure>;
  beatSystems: ReadonlyMap<string, BeatSystem>;
  stylePacks: ReadonlyMap<string, StylePack>;
}

/**
 * Reads every `types/<type>.yaml`, `audiences/<id>.yaml`, `structures/<id>.yaml`,
 * `beat-systems/<id>.yaml` and `style-packs/<id>.yaml` under `dir`. A shape error throws naming the file.
 */
export function loadProfiles(dir: string = DEFAULT_DOCTRINE_DIR): ProfileSet {
  return {
    profiles: readYamlDir(dir, "types", TypeProfileSchema, (profile) => profile.type),
    audiences: readYamlDir(dir, "audiences", AudiencePackSchema, (pack) => pack.id),
    structures: loadStructures(dir),
    beatSystems: loadBeatSystems(dir),
    stylePacks: loadStylePacks(dir),
  };
}

/** Reads every `structures/<id>.yaml` under `dir`: the narrative structure registry. */
export function loadStructures(dir: string = DEFAULT_DOCTRINE_DIR): Map<string, NarrativeStructure> {
  return readYamlDir(dir, "structures", NarrativeStructureSchema, (structure) => structure.id);
}

export class UnknownProfileError extends Error {
  constructor(type: string, known: string[]) {
    super(`unknown profile ${type}; known: ${known.join(", ")}`);
    this.name = "UnknownProfileError";
  }
}

/** The profile for one video type; an unknown type throws, listing the known ones, rather than running unprofiled. */
export function profileFor(set: ProfileSet, type: string): TypeProfile {
  const profile = set.profiles.get(type);
  if (profile) return profile;
  throw new UnknownProfileError(type, [...set.profiles.keys()]);
}

export class UnknownStructureError extends Error {
  constructor(id: string, known: string[]) {
    super(`unknown structure ${id}; known: ${known.join(", ")}`);
    this.name = "UnknownStructureError";
  }
}

/** The registered structure `id`; an unknown one throws, listing the known ones, rather than running unshaped. */
export function structureFor(structures: ReadonlyMap<string, NarrativeStructure>, id: string): NarrativeStructure {
  const structure = structures.get(id);
  if (structure) return structure;
  throw new UnknownStructureError(id, [...structures.keys()]);
}
