import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beatSpecFor, loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import { DEFAULT_DOCTRINE_DIR, loadDoctrine } from "./doctrine-load.js";
import type { DoctrineRegistry, DoctrineRule } from "./doctrine-schema.js";
import { sliceForStage } from "./doctrine-slice.js";
import { loadProfiles, profileFor, structureFor, type ProfileSet } from "./profile-load.js";
import type { ProfileBlock, TypeProfile } from "./profile-schema.js";
import { loadRuleRegistry, type RuleRegistry } from "./rules.js";

export interface TypeGuideDeps {
  registry?: DoctrineRegistry;
  qRules?: RuleRegistry;
  profiles?: ProfileSet;
  beats?: ReadonlyMap<string, BeatSpec>;
}

const minutes = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const renderBlock = ({ id, goal, seconds, beats, require = [] }: ProfileBlock): string =>
  `- **${id}** (${seconds[0]}-${seconds[1]} s): ${goal} Beats: ${beats.join(", ")}${require.length > 0 ? `; must include ${require.join(", ")}` : ""}.`;

const macrosOf = ({ structure }: TypeProfile): string[] =>
  structure.order === "fixed" ? [structure.macro] : [...new Set([...structure.heuristic.map((row) => row.macro), structure.fallback])];

function renderStructure({ structure }: TypeProfile, set: ProfileSet): string {
  if (structure.order === "fixed") {
    return [`Macro: ${structure.macro}. The chapters play in this order every time; they are the viewer's map.`, "", ...structure.blocks.map(renderBlock)].join("\n");
  }
  const rows = structure.heuristic.map(({ ask, macro }, i) => {
    const { minRuntimeS } = structureFor(set.structures, macro).fit;
    return `${i + 1}. ${ask} Then **${macro}**${minRuntimeS ? ` (at ${minutes(minRuntimeS)} or longer)` : ""}.`;
  });
  const macros = Object.entries(structure.macros).map(([macro, ids]) => `- **${macro}**: ${ids.join(" → ")}`);
  return [
    "Pick the macro structure: ask these in order and stop at the first yes.",
    "",
    ...rows,
    `${rows.length + 1}. None of these: **${structure.fallback}**.`,
    "",
    "Block order per macro:",
    "",
    ...macros,
    "",
    "Blocks:",
    "",
    ...structure.blocks.map(renderBlock),
  ].join("\n");
}

function renderProfile(profile: TypeProfile, set: ProfileSet): string {
  const pack = set.audiences.get(profile.audience.default);
  const { targetS, minS, maxS, splitAboveS } = profile.runtime;
  const cuts = profile.cuts.map(({ id, when, runtimeS }) => `- **${id}** (${minutes(runtimeS[0])}-${minutes(runtimeS[1])}): ${when}`);
  return [
    `# Planner guide: ${profile.type}`,
    `<!-- Generated from doctrine/types/${profile.type}.yaml (profile ${profile.version}) by \`explainer guide types\`. Do not edit. -->`,
    profile.intent,
    `## Audience\n\n${profile.audience.default}${pack ? `: ${pack.viewer}` : ""}`,
    `## Runtime\n\nAim for ${minutes(targetS)}, within ${minutes(minS)}-${minutes(maxS)}. Above ${minutes(splitAboveS)}, split into episodes.`,
    `## Structure\n\n${renderStructure(profile, set)}`,
    `## Hook and ending\n\n- Hook: ${profile.hook}\n- Ending: ${profile.ending}`,
    ...(cuts.length > 0 ? [`## Cuts\n\n${cuts.join("\n")}`] : []),
    `## Series\n\nMay repeat from the previous video: ${profile.series.mayRepeat.join(", ") || "nothing"}.\nMust differ from the previous video: ${profile.series.mustVary.join(", ")}.`,
    `## Audition\n\nSample ${profile.audition.k} or more spines, each ${profile.structure.order === "fixed" ? "with a different beat system inside the fixed chapters" : "under a different macro structure"}, and stop at the storyboard.`,
  ].join("\n\n");
}

/** The planner's beat index (VT §5.4): each beat the profile's blocks allow, with its purpose, role and duration range. */
function renderBeatIndex(profile: TypeProfile, beats: ReadonlyMap<string, BeatSpec>): string {
  const types = [...new Set(profile.structure.blocks.flatMap((block) => block.beats))];
  const rows = types.map((type) => {
    const { summary, role, durationS } = beatSpecFor(beats, type);
    return `- **${type}** (${role}, ${durationS[0]}-${durationS[2]} s): ${summary}`;
  });
  return `## Beats

${rows.join("\n")}`;
}

const renderRule = ({ id, text }: DoctrineRule): string => `- **${id}**: ${text}`;

/** The plan-stage rules a video gets only when it picks `structure`. */
function structureRules(structure: string, registry: DoctrineRegistry, qRules: RuleRegistry): DoctrineRule[] {
  const { prompt } = sliceForStage(registry, qRules, { stage: "plan", structure });
  return prompt.filter((rule) => (rule.scope.structures ?? []).includes(structure));
}

/** Each structure the profile may pick: its shape, its spine sections and the rules it brings. */
function renderStructures(profile: TypeProfile, set: ProfileSet, registry: DoctrineRegistry, qRules: RuleRegistry): string {
  const entries = macrosOf(profile).map((id) => {
    const { summary, source, spine } = structureFor(set.structures, id);
    const rules = structureRules(id, registry, qRules).map(renderRule);
    const sections = spine.map(({ title }, i) => `${i + 1}. ${title}`).join("; ");
    return [`### ${id}`, "", `${summary} (${source})`, "", `Spine sections: ${sections}.`, ...(rules.length > 0 ? ["", ...rules] : [])].join("\n");
  });
  return `## Structures\n\nThe spine you write follows the structure you pick. The runner-up goes in the render notes.\n\n${entries.join("\n\n")}`;
}

/**
 * One video type's planner guide: its profile, then the plan-stage rules for the type and its
 * default audience. Gate thresholds stay out: QA reads them from the profile, never the planner.
 */
export function guideForType(type: string, deps: TypeGuideDeps = {}): string {
  const { registry = loadDoctrine(), qRules = loadRuleRegistry(), profiles = loadProfiles(), beats = loadBeatSpecs() } = deps;
  const profile = profileFor(profiles, type);
  const { prompt } = sliceForStage(registry, qRules, { stage: "plan", type, audience: profile.audience.default });
  const rules = prompt.length > 0 ? prompt.map(renderRule).join("\n") : "- (none)";
  return `${renderProfile(profile, profiles)}\n\n${renderStructures(profile, profiles, registry, qRules)}\n\n${renderBeatIndex(profile, beats)}\n\n## Rules for the plan stage\n\n${rules}\n`;
}

/** Writes `guides/planner/<type>.md` for every profile under `doctrineDir`; returns the types written. */
export function writeTypeGuides(doctrineDir: string = DEFAULT_DOCTRINE_DIR, deps: TypeGuideDeps = {}): string[] {
  const profiles = deps.profiles ?? loadProfiles(doctrineDir);
  const beats = deps.beats ?? loadBeatSpecs(doctrineDir);
  const outDir = join(doctrineDir, "guides", "planner");
  mkdirSync(outDir, { recursive: true });
  const types = [...profiles.profiles.keys()];
  for (const type of types) writeFileSync(join(outDir, `${type}.md`), guideForType(type, { ...deps, profiles, beats }));
  return types;
}
