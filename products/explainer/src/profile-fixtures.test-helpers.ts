import type { ProfileSet } from "./profile-load.js";
import type { AudiencePack, HeuristicStructure, TypeProfile } from "./profile-schema.js";
import type { BeatSystem } from "./beat-system-schema.js";
import type { NarrativeStructure, StructureFit } from "./structure-schema.js";
import { VOCABULARY } from "./doctrine-fixtures.test-helpers.js";
import type { StylePack } from "./style-pack-schema.js";

// Invented profiles over the invented doctrine vocabulary; none is a shipped profile.

export const PROFILE_VOCABULARY = { ...VOCABULARY, audiences: ["owner-internal", "public-youtube"] };

const pack = (id: string, publishable: boolean): AudiencePack => ({
  schema: "audience-pack/v1",
  id,
  viewer: `${id} viewer`,
  verdicts: publishable ? "none" : "titan-relative",
  publishable,
});

const AUDIENCES = new Map([
  ["owner-internal", pack("owner-internal", false)],
  ["public-youtube", pack("public-youtube", true)],
]);

const block = (id: string) => ({ id, goal: `${id} goal.`, seconds: [10, 20] as [number, number], beats: ["hook"] });

/** A sound pack over real token names; overrides replace whole top-level fields. */
export const stylePack = (id: string, overrides: Partial<StylePack> = {}): StylePack => ({
  schema: "style-pack/v1",
  id,
  theme: "dark",
  feel: `${id} feel.`,
  tokens: {
    ground: "color-background-base", surface: "color-surface-raised", text: "color-text-primary", textMuted: "color-text-secondary",
    accent: "color-brand-primary", accentSoft: "color-brand-primary-subtle", rule: "color-hairline-default", lift: "lift-2",
    heading: "font-family-heading", body: "font-family-body", code: "font-family-mono", duration: "duration-normal", ease: "ease-out",
  },
  ...overrides,
});

/** A sound fixed-order profile; overrides replace whole top-level fields. */
export const fixedProfile = (overrides: Partial<TypeProfile> = {}): TypeProfile => ({
  schema: "type-profile/v1",
  type: "repo-tour",
  version: "0.1.0",
  family: "review-repo",
  intent: "Tour a repo.",
  audience: { default: "owner-internal", allow: ["owner-internal"] },
  inputs: { adapters: [], preconditions: [] },
  runtime: { targetS: 600, minS: 480, maxS: 720, splitAboveS: 900 },
  structure: { order: "fixed", macro: "scqa-c4", blocks: [block("open"), block("map"), block("close")], systems: [] },
  cuts: [],
  hook: "Verdict first.",
  ending: "button",
  series: { mayRepeat: ["frame-chrome", "structure", "chapter-labels"], mustVary: ["hook-kind", "close-kind", "function-mix", "component-histogram", "style-pack"] },
  audition: { k: 3, storyboardOnly: true },
  layers: { customMin: 1, templateMaxShare: 0.7, componentMaxShare: 0.3 },
  variety: { window: 5, minFramings: 3, ngram: 6, mode: "warn" },
  pacing: { pictureChangeMaxS: 5, staticMaxS: 3, held: [1, 2], reHookS: [60, 90] },
  coverage: [],
  styles: { allow: ["plain", "bold"] },
  voice: { id: "af_heart", rate: 1 },
  ...overrides,
});

/** A sound structure fitting on `fit`; overrides replace whole top-level fields. */
export const narrativeStructure = (id: string, fit: Partial<StructureFit> = {}, overrides: Partial<NarrativeStructure> = {}): NarrativeStructure => ({
  schema: "narrative-structure/v1",
  id,
  version: "0.1.0",
  source: `${id} source`,
  summary: `${id} summary.`,
  fit: { ask: `${id}?`, all: [], any: [], none: [], ...fit },
  blocks: [
    { id: "open", goal: "Open.", share: 0.4 },
    { id: "close", goal: "Close.", share: 0.6 },
  ],
  hook: "Hook.",
  ending: "button",
  spine: [{ title: "Only", body: "<fill>" }],
  ...overrides,
});

/** A sound beat system over the invented beats; overrides replace whole top-level fields. */
export const beatSystem = (id: string, overrides: Partial<BeatSystem> = {}): BeatSystem => ({
  schema: "beat-system/v1",
  id,
  version: "0.1.0",
  source: `${id} source`,
  summary: `${id} summary.`,
  steps: [
    { beats: ["hook"], does: "Open." },
    { beats: ["code-walk"], does: "Walk.", optional: true },
    { beats: ["hook"], does: "Close." },
  ],
  ...overrides,
});

export const BEAT_SYSTEMS: ReadonlyMap<string, BeatSystem> = new Map([
  ["walk-first", beatSystem("walk-first", { steps: [{ beats: ["code-walk"], does: "Walk." }, { beats: ["hook"], does: "Close." }] })],
  ["hook-close", beatSystem("hook-close")],
]);

/** Deciding → scqa, anomaly → mystery, problem → three-act at 300 s or longer, else abt. */
export const STRUCTURES: ReadonlyMap<string, NarrativeStructure> = new Map(
  [
    narrativeStructure("scqa-c4", { any: ["deciding"] }),
    narrativeStructure("scqa", { any: ["deciding"] }),
    narrativeStructure("mystery", { any: ["anomaly"] }),
    narrativeStructure("three-act", { all: ["problem"], minRuntimeS: 300 }),
    narrativeStructure("abt", { all: ["problem"] }),
  ].map((structure) => [structure.id, structure]),
);

export const HEURISTIC: HeuristicStructure = {
  order: "heuristic",
  heuristic: [
    { macro: "scqa", ask: "Deciding?" },
    { macro: "mystery", ask: "Anomaly?" },
    { macro: "three-act", ask: "Long problem?" },
    { macro: "abt", ask: "Short problem?" },
  ],
  fallback: "abt",
  macros: { scqa: ["setup", "answer", "close"], mystery: ["anomaly", "reveal", "close"], "three-act": ["setup", "struggle", "answer", "close"], abt: ["setup", "turn", "close"] },
  blocks: ["setup", "answer", "anomaly", "reveal", "struggle", "turn", "close"].map(block),
  systems: [],
};

/** A sound heuristic-order profile over `HEURISTIC`. */
export const heuristicProfile = (overrides: Partial<TypeProfile> = {}): TypeProfile =>
  fixedProfile({
    type: "repo-argument",
    runtime: { targetS: 240, minS: 210, maxS: 300, splitAboveS: 360 },
    structure: HEURISTIC,
    series: { mayRepeat: ["frame-chrome"], mustVary: ["structure", "hook-kind", "close-kind", "function-mix", "component-histogram", "style-pack"] },
    voice: { id: "am_adam", rate: 1 },
    ...overrides,
  });

export const setOf = (...profiles: TypeProfile[]): ProfileSet => ({
  profiles: new Map(profiles.map((profile) => [profile.type, profile])),
  audiences: AUDIENCES,
  structures: STRUCTURES,
  beatSystems: BEAT_SYSTEMS,
  stylePacks: new Map([["plain", stylePack("plain")], ["bold", stylePack("bold")]]),
});
