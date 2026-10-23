import type { ProfileSet } from "./profile-load.js";
import type { AudiencePack, HeuristicStructure, TypeProfile } from "./profile-schema.js";
import type { NarrativeStructure, StructureFit } from "./structure-schema.js";
import { VOCABULARY } from "./doctrine-fixtures.test-helpers.js";

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
  structure: { order: "fixed", macro: "scqa-c4", blocks: [block("open"), block("map"), block("close")] },
  cuts: [],
  hook: "Verdict first.",
  ending: "button",
  series: { mayRepeat: ["frame-chrome", "structure", "chapter-labels"], mustVary: ["hook-kind", "close-kind", "function-mix", "component-histogram", "style-pack"] },
  audition: { k: 3, storyboardOnly: true },
  layers: { customMin: 1, templateMaxShare: 0.7, componentMaxShare: 0.3 },
  variety: { window: 5, minFramings: 3, ngram: 6, mode: "warn" },
  pacing: { pictureChangeMaxS: 5, staticMaxS: 3, held: [1, 2], reHookS: [60, 90] },
  coverage: [],
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
};

/** A sound heuristic-order profile over `HEURISTIC`. */
export const heuristicProfile = (overrides: Partial<TypeProfile> = {}): TypeProfile =>
  fixedProfile({
    type: "repo-argument",
    runtime: { targetS: 240, minS: 210, maxS: 300, splitAboveS: 360 },
    structure: HEURISTIC,
    series: { mayRepeat: ["frame-chrome"], mustVary: ["structure", "hook-kind", "close-kind", "function-mix", "component-histogram", "style-pack"] },
    ...overrides,
  });

export const setOf = (...profiles: TypeProfile[]): ProfileSet => ({
  profiles: new Map(profiles.map((profile) => [profile.type, profile])),
  audiences: AUDIENCES,
  structures: STRUCTURES,
});
