import { loadDoctrine } from "../doctrine-load.js";
import { canonicalJson } from "../eval-store.js";
import { parseFacts } from "../material-facts.js";
import { buildMaterialMap, registrySha, type MaterialMap } from "../material-map.js";
import { loadProfiles, profileFor } from "../profile-load.js";
import { sha256 } from "./artifacts.js";
import type { ModelStageInput } from "./model-stages.js";
import type { StageOutcome } from "./records.js";

/** What the audition's stage key covers beyond the facts sha: the profile's version and content, and the registry's. */
interface AuditionConfig {
  profile: { type: string; version: string; sha: string };
  structures: string;
}

/** Read when the spec is built, so a profile or structure edit is a new key and never a stale cache hit. */
export function auditionConfig(type: string): AuditionConfig {
  const set = loadProfiles();
  const profile = profileFor(set, type);
  return { profile: { type, version: profile.version, sha: sha256(canonicalJson(profile)) }, structures: registrySha(set.structures) };
}

function summary(map: MaterialMap): string[] {
  const holding = map.signals.filter((row) => row.holds === true).map((row) => row.id);
  const outside = map.fits.filter((row) => row.fit === "fits" && !row.allowed).map((row) => row.structure);
  const undecided = map.fits.filter((row) => row.fit === "undecided").map((row) => row.structure);
  return [
    `${map.facts.count} facts; signals holding: ${holding.join(", ") || "none"}; gaps: ${map.gaps.join(", ") || "none"}`,
    `candidates (fit and allowed by ${map.profile.type}): ${map.candidates.join(", ") || "none"}`,
    `fit outside the profile: ${outside.join(", ") || "none"}; undecided on a gap: ${undecided.join(", ") || "none"}`,
  ];
}

/**
 * The audition's first steps (PP-7): the material map and its fit predicates, from the facts and the profile, with
 * no model call. The spec's config pins the doctrine it was keyed on; a body that reads other doctrine refuses.
 */
export function runAuditionStage(input: ModelStageInput, config: AuditionConfig): StageOutcome {
  const now = auditionConfig(config.profile.type);
  if (canonicalJson(now) !== canonicalJson(config)) throw new Error(`audition: the profile or structure registry changed since this stage was keyed; build a new spec`);
  const factsSha = input.artifacts.facts;
  if (factsSha === undefined) throw new Error(`stage audition needs artifact "facts", which no earlier stage produced`);
  const { format, facts } = parseFacts(input.store.readText(factsSha));
  const set = loadProfiles();
  const map = buildMaterialMap({
    factsSha, format, facts, profile: profileFor(set, config.profile.type), structures: set.structures, vocabulary: loadDoctrine().vocabulary.signals,
  });
  const sha = input.store.putText(`${JSON.stringify(map, null, 2)}\n`, "material-map", input.from);
  return { outputs: { "material-map": sha }, checks: [{ name: "material-map", pass: true, detail: `${map.signals.length} signals, ${map.candidates.length} candidates` }], notes: summary(map) };
}
