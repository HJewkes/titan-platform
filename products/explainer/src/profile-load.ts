import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { AudiencePackSchema, TypeProfileSchema, type AudiencePack, type TypeProfile } from "./profile-schema.js";
import { NarrativeStructureSchema, type NarrativeStructure } from "./structure-schema.js";

/** `explain-repo` makes a tour unless asked otherwise (decision 326.1). */
export const EXPLAIN_REPO_DEFAULT_TYPE = "repo-tour" as const;

export interface ProfileSet {
  profiles: ReadonlyMap<string, TypeProfile>;
  audiences: ReadonlyMap<string, AudiencePack>;
  structures: ReadonlyMap<string, NarrativeStructure>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readYamlDir<T>(dir: string, sub: string, schema: z.ZodType<T>, key: (item: T) => string): Map<string, T> {
  const path = join(dir, sub);
  const files = existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".yaml")).sort() : [];
  return new Map(
    files.map((name) => {
      const file = `${sub}/${name}`;
      let item: T;
      try {
        item = schema.parse(parse(readFileSync(join(path, name), "utf8")));
      } catch (error) {
        throw new Error(`${file}: ${describe(error)}`);
      }
      if (`${key(item)}.yaml` !== name) throw new Error(`${file}: names ${key(item)}, so the file is ${key(item)}.yaml`);
      return [key(item), item];
    }),
  );
}

/**
 * Reads every `types/<type>.yaml`, `audiences/<id>.yaml` and `structures/<id>.yaml` under `dir`.
 * A shape error throws naming the file.
 */
export function loadProfiles(dir: string = DEFAULT_DOCTRINE_DIR): ProfileSet {
  return {
    profiles: readYamlDir(dir, "types", TypeProfileSchema, (profile) => profile.type),
    audiences: readYamlDir(dir, "audiences", AudiencePackSchema, (pack) => pack.id),
    structures: loadStructures(dir),
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
