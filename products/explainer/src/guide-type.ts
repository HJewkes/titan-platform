import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOCTRINE_DIR, loadDoctrine } from "./doctrine-load.js";
import type { DoctrineRegistry, DoctrineRule } from "./doctrine-schema.js";
import { sliceForStage } from "./doctrine-slice.js";
import { loadProfiles, profileFor, type ProfileSet } from "./profile-load.js";
import type { ProfileBlock, TypeProfile } from "./profile-schema.js";
import { loadRuleRegistry, type RuleRegistry } from "./rules.js";

export interface TypeGuideDeps {
  registry?: DoctrineRegistry;
  qRules?: RuleRegistry;
  profiles?: ProfileSet;
}

const minutes = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const renderBlock = ({ id, goal, seconds, beats, require = [] }: ProfileBlock): string =>
  `- **${id}** (${seconds[0]}-${seconds[1]} s): ${goal} Beats: ${beats.join(", ")}${require.length > 0 ? `; must include ${require.join(", ")}` : ""}.`;

function renderStructure({ structure }: TypeProfile): string {
  if (structure.order === "fixed") {
    return [`Macro: ${structure.macro}. The chapters play in this order every time; they are the viewer's map.`, "", ...structure.blocks.map(renderBlock)].join("\n");
  }
  const rows = structure.heuristic.map(({ ask, macro, minRuntimeS }, i) => `${i + 1}. ${ask} Then **${macro}**${minRuntimeS ? ` (at ${minutes(minRuntimeS)} or longer)` : ""}.`);
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
    `## Structure\n\n${renderStructure(profile)}`,
    `## Hook and ending\n\n- Hook: ${profile.hook}\n- Ending: ${profile.ending}`,
    ...(cuts.length > 0 ? [`## Cuts\n\n${cuts.join("\n")}`] : []),
    `## Series\n\nMay repeat from the previous video: ${profile.series.mayRepeat.join(", ") || "nothing"}.\nMust differ from the previous video: ${profile.series.mustVary.join(", ")}.`,
    `## Audition\n\nSample ${profile.audition.k} or more spines, each ${profile.structure.order === "fixed" ? "with a different beat system inside the fixed chapters" : "under a different macro structure"}, and stop at the storyboard.`,
  ].join("\n\n");
}

const renderRule = ({ id, text }: DoctrineRule): string => `- **${id}**: ${text}`;

/**
 * One video type's planner guide: its profile, then the plan-stage rules for the type and its
 * default audience. Gate thresholds stay out: QA reads them from the profile, never the planner.
 */
export function guideForType(type: string, deps: TypeGuideDeps = {}): string {
  const { registry = loadDoctrine(), qRules = loadRuleRegistry(), profiles = loadProfiles() } = deps;
  const profile = profileFor(profiles, type);
  const { prompt } = sliceForStage(registry, qRules, { stage: "plan", type, audience: profile.audience.default });
  const rules = prompt.length > 0 ? prompt.map(renderRule).join("\n") : "- (none)";
  return `${renderProfile(profile, profiles)}\n\n## Rules for the plan stage\n\n${rules}\n`;
}

/** Writes `guides/planner/<type>.md` for every profile under `doctrineDir`; returns the types written. */
export function writeTypeGuides(doctrineDir: string = DEFAULT_DOCTRINE_DIR, deps: TypeGuideDeps = {}): string[] {
  const profiles = deps.profiles ?? loadProfiles(doctrineDir);
  const outDir = join(doctrineDir, "guides", "planner");
  mkdirSync(outDir, { recursive: true });
  const types = [...profiles.profiles.keys()];
  for (const type of types) writeFileSync(join(outDir, `${type}.md`), guideForType(type, { ...deps, profiles }));
  return types;
}
