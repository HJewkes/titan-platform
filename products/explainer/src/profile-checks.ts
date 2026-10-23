import { placeBeatSystem } from "./beat-system-schema.js";
import type { DoctrineVocabulary } from "./doctrine-schema.js";
import type { ProfileSet } from "./profile-load.js";
import type { ProfileBlock, SeriesField, SystemBinding, TypeProfile } from "./profile-schema.js";

export const PROFILE_ISSUE_CODES = [
  "unknown-vocabulary",
  "unknown-audience",
  "audience-not-allowed",
  "dangling-ref",
  "unknown-structure",
  "runtime-order",
  "series-overlap",
  "series-base-missing",
  "series-structure-mismatch",
  "publish-unguarded",
  "unknown-beat-system",
  "beat-system-order",
] as const;

export type ProfileIssueCode = (typeof PROFILE_ISSUE_CODES)[number];

export interface ProfileIssue {
  code: ProfileIssueCode;
  profile: string;
  message: string;
}

type ProfileCheck = (profile: TypeProfile, set: ProfileSet, vocabulary: DoctrineVocabulary) => ProfileIssue[];

/**
 * What every profile's next video must change (plan §A.4 "All" row). The daily is held to the same
 * set as the reviews (owner Q2 B); the signature layer is left to each profile, being a hypothesis.
 */
export const SERIES_BASE: readonly SeriesField[] = ["hook-kind", "close-kind", "function-mix", "component-histogram", "style-pack"];

/** Fields a fixed chapter order repeats by construction; a heuristic order must vary the first. */
const FIXED_ORDER_FIELDS: readonly SeriesField[] = ["structure", "chapter-labels"];

/** Owner Q4 B: a paper video may be published only with every figure re-plotted from data and short quotes. */
export const PAPER_PUBLISH_CHECKS = ["figures-replotted-from-data", "quotes-short"] as const;

const issue = (code: ProfileIssueCode, profile: TypeProfile, message: string): ProfileIssue => ({ code, profile: profile.type, message });

function vocabulary(profile: TypeProfile, _set: ProfileSet, allowed: DoctrineVocabulary): ProfileIssue[] {
  const beats = profile.structure.blocks.flatMap((block) => [...block.beats, ...(block.require ?? [])]);
  const types = [profile.type, ...profile.cuts.flatMap((cut) => (cut.type ? [cut.type] : []))];
  const unknown = [
    ...[...new Set(beats)].filter((name) => !allowed.beats.includes(name)).map((name) => `beat ${name}`),
    ...types.filter((name) => !allowed.types.includes(name)).map((name) => `type ${name}`),
  ];
  return unknown.map((name) => issue("unknown-vocabulary", profile, `${name} is not in vocabulary.yaml`));
}

function audiences(profile: TypeProfile, { audiences: packs }: ProfileSet, allowed: DoctrineVocabulary): ProfileIssue[] {
  const unknown = profile.audience.allow
    .filter((name) => !packs.has(name) || !allowed.audiences.includes(name))
    .map((name) => issue("unknown-audience", profile, `audience ${name} has no audiences/${name}.yaml or vocabulary entry`));
  const notAllowed = profile.audience.allow.includes(profile.audience.default)
    ? []
    : [issue("audience-not-allowed", profile, `the default audience ${profile.audience.default} is not in audience.allow`)];
  return [...unknown, ...notAllowed];
}

function structureRefs(profile: TypeProfile): ProfileIssue[] {
  const { structure } = profile;
  if (structure.order === "fixed") return [];
  const blocks = new Set(structure.blocks.map((block) => block.id));
  const macros = new Set(Object.keys(structure.macros));
  const missingBlocks = Object.entries(structure.macros).flatMap(([macro, ids]) =>
    ids.filter((id) => !blocks.has(id)).map((id) => issue("dangling-ref", profile, `macro ${macro} names block ${id}, which is not in blocks`)),
  );
  const missingMacros = [...structure.heuristic.map((row) => row.macro), structure.fallback]
    .filter((macro) => !macros.has(macro))
    .map((macro) => issue("dangling-ref", profile, `macro ${macro} is not in macros`));
  return [...missingBlocks, ...missingMacros];
}

/** Every macro a profile names, fixed or heuristic, is a registered structure (plan §A.2). */
function registeredStructures(profile: TypeProfile, { structures }: ProfileSet): ProfileIssue[] {
  const { structure } = profile;
  const named = structure.order === "fixed" ? [structure.macro] : [...Object.keys(structure.macros), ...structure.heuristic.map((row) => row.macro), structure.fallback];
  return [...new Set(named)]
    .filter((macro) => !structures.has(macro))
    .map((macro) => issue("unknown-structure", profile, `macro ${macro} has no structures/${macro}.yaml`));
}

function runtimeOrder(profile: TypeProfile): ProfileIssue[] {
  const { minS, targetS, maxS, splitAboveS } = profile.runtime;
  return minS <= targetS && targetS <= maxS && maxS <= splitAboveS
    ? []
    : [issue("runtime-order", profile, "runtime needs minS <= targetS <= maxS <= splitAboveS")];
}

function series(profile: TypeProfile): ProfileIssue[] {
  const { mayRepeat, mustVary } = profile.series;
  const both = mustVary.filter((field) => mayRepeat.includes(field)).map((field) => issue("series-overlap", profile, `${field} is in both mayRepeat and mustVary`));
  const missing = SERIES_BASE.filter((field) => !mustVary.includes(field)).map((field) => issue("series-base-missing", profile, `mustVary lacks ${field}`));
  return [...both, ...missing, ...seriesStructure(profile)];
}

function seriesStructure(profile: TypeProfile): ProfileIssue[] {
  const { mustVary } = profile.series;
  if (profile.structure.order === "fixed") {
    return FIXED_ORDER_FIELDS.filter((field) => mustVary.includes(field)).map((field) =>
      issue("series-structure-mismatch", profile, `a fixed chapter order repeats ${field}, so mustVary cannot list it`),
    );
  }
  return mustVary.includes("structure") ? [] : [issue("series-structure-mismatch", profile, "a heuristic order picks a structure per video, so mustVary lists structure")];
}

function publish(profile: TypeProfile, { audiences: packs }: ProfileSet): ProfileIssue[] {
  const publishable = profile.audience.allow.some((name) => packs.get(name)?.publishable === true);
  const issues: ProfileIssue[] = [];
  if (publishable && profile.publish?.ownerAskPerVideo !== true) {
    issues.push(issue("publish-unguarded", profile, "a profile with a publishable audience asks the owner before each publish"));
  }
  if (profile.family === "review-paper") {
    const missing = PAPER_PUBLISH_CHECKS.filter((check) => !(profile.publish?.checks ?? []).includes(check));
    issues.push(...missing.map((check) => issue("publish-unguarded", profile, `a paper profile carries the ${check} publish check`)));
  }
  return issues;
}

/** The block ids macro `macro` plays in this profile, or undefined when the profile has no such macro. */
function macroBlocks({ structure }: TypeProfile, macro: string): string[] | undefined {
  if (structure.order === "fixed") return structure.macro === macro ? structure.blocks.map((block) => block.id) : undefined;
  return structure.macros[macro];
}

/** The blocks one binding spans, in macro order, or the names it gets wrong. */
function boundBlocks(profile: TypeProfile, { macro, blocks: only }: SystemBinding): { blocks: ProfileBlock[] } | { dangling: string[] } {
  const ids = macroBlocks(profile, macro);
  if (!ids) return { dangling: [`macro ${macro} is not one this profile plays`] };
  const outside = (only ?? []).filter((id) => !ids.includes(id)).map((id) => `block ${id} is not in macro ${macro}`);
  if (outside.length > 0) return { dangling: outside };
  const spanned = only ? ids.filter((id) => only.includes(id)) : ids;
  return { blocks: spanned.flatMap((id) => profile.structure.blocks.filter((block) => block.id === id)) };
}

/**
 * Each beat system a profile binds is registered, and its required steps land, in order, in the
 * blocks it spans: the system is a beat order inside the structure's blocks, not a second structure.
 */
function beatSystems(profile: TypeProfile, { beatSystems: registry }: ProfileSet): ProfileIssue[] {
  return profile.structure.systems.flatMap((binding) => {
    const system = registry.get(binding.system);
    if (!system) return [issue("unknown-beat-system", profile, `beat system ${binding.system} has no beat-systems/${binding.system}.yaml`)];
    const span = boundBlocks(profile, binding);
    if ("dangling" in span) return span.dangling.map((message) => issue("dangling-ref", profile, `beat system ${binding.system}: ${message}`));
    return placeBeatSystem(system, span.blocks).unplaced.map((step) =>
      issue("beat-system-order", profile, `beat system ${binding.system} in ${binding.macro}: step ${step + 1} (${system.steps[step]!.beats.join(" or ")}) lands in no block after the step before it`),
    );
  });
}

const PROFILE_CHECKS: ProfileCheck[] = [vocabulary, audiences, structureRefs, registeredStructures, runtimeOrder, series, publish, beatSystems];

/** Every cross-field and cross-file refinement over the loaded profiles. Empty when sound. */
export function checkProfiles(set: ProfileSet, vocabulary: DoctrineVocabulary): ProfileIssue[] {
  return [...set.profiles.values()].flatMap((profile) => PROFILE_CHECKS.flatMap((check) => check(profile, set, vocabulary)));
}
