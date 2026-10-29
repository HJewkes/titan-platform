import { existsSync } from "node:fs";
import { join } from "node:path";
import { BeatSystemSchema, type BeatSystem } from "./beat-system-schema.js";
import { DEFAULT_DOCTRINE_DIR, loadVocabulary } from "./doctrine-load.js";
import type { DoctrineVocabulary } from "./doctrine-schema.js";
import { readYamlDir } from "./yaml-dir.js";

export class BeatSystemError extends Error {
  constructor(problems: string[]) {
    super(`beat systems: ${problems.join("; ")}`);
    this.name = "BeatSystemError";
  }
}

export class UnknownBeatSystemError extends Error {
  constructor(id: string, known: string[]) {
    super(`unknown beat system ${id}; known: ${known.join(", ")}`);
    this.name = "UnknownBeatSystemError";
  }
}

/** What a beat-system registry gets wrong against the vocabulary: unnamed systems, missing files, beats it does not know. */
export function beatSystemProblems(systems: ReadonlyMap<string, BeatSystem>, vocabulary: DoctrineVocabulary): string[] {
  const unnamed = [...systems.keys()].filter((id) => !vocabulary.beatSystems.includes(id)).map((id) => `beat system ${id} is not in vocabulary.yaml`);
  const missing = vocabulary.beatSystems.filter((id) => !systems.has(id)).map((id) => `vocabulary.yaml names ${id}, which has no beat-systems/${id}.yaml`);
  const beats = [...systems.values()].flatMap(({ id, steps }) =>
    [...new Set(steps.flatMap((step) => step.beats))].filter((beat) => !vocabulary.beats.includes(beat)).map((beat) => `beat system ${id} plays beat ${beat}, which is not in vocabulary.yaml`),
  );
  return [...unnamed, ...missing, ...beats];
}

/**
 * Reads every `beat-systems/<id>.yaml` under `dir` and checks it against that dir's vocabulary. A
 * shape error throws naming the file; an unknown system or a step beat outside the vocabulary throws too.
 */
export function loadBeatSystems(dir: string = DEFAULT_DOCTRINE_DIR): Map<string, BeatSystem> {
  if (!existsSync(join(dir, "beat-systems"))) return new Map();
  const systems = readYamlDir(dir, "beat-systems", BeatSystemSchema, (system) => system.id);
  const problems = beatSystemProblems(systems, loadVocabulary(dir));
  if (problems.length > 0) throw new BeatSystemError(problems);
  return systems;
}

/** The registered beat system `id`; an unknown one throws, listing the known ones. */
export function beatSystemFor(systems: ReadonlyMap<string, BeatSystem>, id: string): BeatSystem {
  const system = systems.get(id);
  if (system) return system;
  throw new UnknownBeatSystemError(id, [...systems.keys()]);
}
