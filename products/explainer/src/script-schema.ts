import { z } from "zod";
import { cueResolverFromWords } from "./cues.js";
import { EDGE_SOURCES, MapStateSchema, VisualSchema, type MapState } from "./map-state.js";

const Id = z.string().min(1);
const Text = z.string().min(1);
const Cue = z.string().regex(/^[^\s#]+(?:#[1-9]\d*)?$/, "expected word or word#n");

// A required authored field the writer has not filled yet. It parses, so the L0 lints report
// every gap at once instead of the parser stopping at the first one.
const Todo = z.string().regex(/^TODO:/, "expected a TODO: placeholder");
const authored = <T extends z.ZodType>(schema: T) => z.union([schema, Todo]);

export const BEAT_FUNCTIONS = [
  "HOOK",
  "STAKE",
  "PROMISE",
  "MISCONCEPTION",
  "GENERIC_MODEL",
  "WHAT",
  "HOW",
  "FENCE",
  "HISTORY",
  "LEARNER_Q",
  "CAVEAT",
  "VERDICT",
  "SIGN",
  "CLOSE",
] as const;
export const BEAT_MODES = ["explain", "demo", "ref"] as const;
export const CHIP_KINDS = ["verified", "computed", "docs-claim", "our-framing", "illustrative", "inferred"] as const;
export const CLOSE_TYPES = ["lesson", "try-it", "callback", "refrain", "audience-rec"] as const;
/** Off-map cue actions; a map beat's per-cue changes are `map_state` ops instead. */
export const OFF_MAP_ACTIONS = ["V6", "V9", "V10", "V11", "V12"] as const;
export const MAX_CODE_LINES = 10;

const Audience = z
  .object({
    persona: Text,
    proximity: Text,
    viewer_knows: z.array(Text).default([]),
    viewer_needs: z.array(Text).default([]),
    gloss: z.enum(["engineer", "broad"]),
  })
  .strict();

const Stake = z.object({ who: Text, loses_what: Text, number: Text, fact_ids: z.array(Id).default([]) }).strict();
const RunningExample = z.object({ scenario: Text, anchor: Text, fact_ids: z.array(Id).default([]) }).strict();

const VideoSchema = z
  .object({
    audience: authored(Audience),
    stake: authored(Stake),
    promise: Text,
    thesis_mechanism: Text,
    thesis_refs: z.array(Id).length(3).optional(),
    generic_model: z.object({ name: Text, slots: z.array(Text).min(1).max(5) }).strict().optional(),
    predecessor: z
      .object({ name: Text, how_shaped_differently: Text, fact_ids: z.array(Id).default([]) })
      .strict()
      .optional(),
    running_example: authored(RunningExample),
    quality_goals: z.array(z.object({ id: Id, goal: Text, scenario: Text }).strict()).max(5).optional(),
    invariants: z.array(Text).max(2).optional(),
    simplifications: z.array(Text),
    scope: Text.optional(),
    non_scope: z.array(Text).default([]),
    glossary: z.array(z.object({ name: Text, job: Text }).strict()).default([]),
    close_type: authored(z.enum(CLOSE_TYPES)),
    map: z.object({ id: Id, layout_sha: Id, layout_source: z.enum(["code-graph", "hand"]) }).strict().optional(),
  })
  .strict();

const ChapterSchema = z
  .object({
    id: Id,
    label: Text,
    question: Text,
    answer_line: Text.optional(),
    concept: Text.optional(),
    disclosure_levels: z.number().int().min(1).max(2).optional(),
  })
  .strict();

const Why = z.object({ need: Text, actor: Text, consequence: Text, fact_ids: z.array(Id).default([]) }).strict();

const CodeRef = z
  .object({
    file: Text,
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    highlight: z.array(z.number().int().positive()).default([]),
  })
  .strict()
  .refine(({ lines: [from, to] }) => to >= from && to - from < MAX_CODE_LINES, {
    message: `expected an ascending range of at most ${MAX_CODE_LINES} lines`,
    path: ["lines"],
  });

const ScriptVisualSchema = z
  .object({
    assertion: Text,
    job: authored(VisualSchema.shape.job),
    layout_source: VisualSchema.shape.layout_source.optional(),
    edge_sources: z.array(z.enum(EDGE_SOURCES)).default([]),
    map_state: MapStateSchema.optional(),
    cues: z
      .array(z.object({ action: z.enum(OFF_MAP_ACTIONS), target: Id, atCue: Cue, hold_s: z.number().positive().optional() }).strict())
      .default([]),
    chips: z.array(z.object({ kind: z.enum(CHIP_KINDS), text: Text, fact_id: Id.optional() }).strict()).default([]),
    labels: z.array(Text).default([]),
    code: CodeRef.optional(),
  })
  .strict();

const ScriptBeatSchema = z
  .object({
    id: Id,
    chapter: Id,
    function: z.enum(BEAT_FUNCTIONS),
    mode: z.enum(BEAT_MODES),
    // A render hint; when it names a visual-router type, the visual:gap-kind lint warns on a gap.
    kind: Text.optional(),
    plannedS: z.number().positive(),
    heldS: z.number().positive().optional(),
    spoken: Text,
    connector_in: z.enum(["but", "therefore", "so", "and"]).optional(),
    why: Why.optional(),
    user_value: z.object({ text: Text, fact_ids: z.array(Id).default([]) }).strict().optional(),
    fact_ids: z.array(Id),
    new_terms: z.array(Text).default([]),
    design_history: z
      .object({ tried: Text, failed_because: Text, changed_to: Text, source_sha: Id })
      .strict()
      .optional(),
    closes_need: Id.optional(),
    visual: ScriptVisualSchema,
    authored: z.object({ assertion_at: z.iso.datetime(), spoken_at: z.iso.datetime() }).strict().optional(),
  })
  .strict();

export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

/** Every spoken cue a beat's visual track names, map ops and off-map cues alike. */
export function beatCues(visual: Pick<ScriptBeat["visual"], "map_state" | "cues">): string[] {
  const s: MapState | undefined = visual.map_state;
  return [
    ...(s?.camera ? [s.camera.atCue] : []),
    ...(s?.reveal ?? []).map((r) => r.atCue),
    ...(s?.edges ?? []).map((e) => e.atCue),
    ...(s?.focus ? [s.focus.atCue] : []),
    ...(s?.message_in_flight ? [s.message_in_flight.atCue] : []),
    ...(s?.cards ?? []).flatMap((c) => (c.untilCue ? [c.atCue, c.untilCue] : [c.atCue])),
    ...(s?.annotations ?? []).map((a) => a.atCue),
    ...(s?.pins ?? []).map((p) => p.atCue),
    ...visual.cues.map((c) => c.atCue),
  ];
}

/** Resolves a beat's cue to the index of the spoken word it names; throws on a cue never spoken. */
export function spokenWordIndex(beat: Pick<ScriptBeat, "id" | "spoken">): (cue: string) => number {
  const words = beat.spoken.split(/\s+/).map((word, i) => ({ word, startS: i }));
  const resolve = cueResolverFromWords({ [beat.id]: words });
  return (cue) => resolve(beat.id, cue);
}

function unspokenCues(beat: ScriptBeat): string[] {
  const index = spokenWordIndex(beat);
  return beatCues(beat.visual).filter((cue) => {
    try {
      index(cue);
      return false;
    } catch {
      return true;
    }
  });
}

type Script = z.infer<typeof ScriptShape>;

function checkReferences(script: Script, ctx: z.RefinementCtx): void {
  const chapters = new Set(script.chapters.map((c) => c.id));
  const beatIds = new Set<string>();
  script.beats.forEach((beat, i) => {
    if (beatIds.has(beat.id)) ctx.addIssue({ code: "custom", path: ["beats", i, "id"], message: `duplicate beat ${beat.id}` });
    beatIds.add(beat.id);
    if (!chapters.has(beat.chapter)) {
      ctx.addIssue({ code: "custom", path: ["beats", i, "chapter"], message: `unknown chapter ${beat.chapter}` });
    }
    for (const cue of unspokenCues(beat)) {
      ctx.addIssue({ code: "custom", path: ["beats", i, "visual"], message: `cue "${cue}" is not spoken in ${beat.id}` });
    }
  });
  (script.video.thesis_refs ?? []).forEach((ref, i) => {
    if (!beatIds.has(ref)) ctx.addIssue({ code: "custom", path: ["video", "thesis_refs", i], message: `unknown beat ${ref}` });
  });
}

const ScriptShape = z
  .object({
    schema: z.literal("script/v1"),
    id: Id,
    profile: Text,
    parent_sha: Id.optional(),
    facts_pack: Text,
    repo_map_sha: Id.optional(),
    video: VideoSchema,
    chapters: z.array(ChapterSchema).min(1),
    beats: z.array(ScriptBeatSchema).min(1),
    companion: z.object({ codemap: Text, reading_list: Text, full_scorecard: Text }).partial().strict().optional(),
  })
  .strict();

/** `script/v1`: one two-track script, a narration track and a visual track per beat. */
export const ScriptSchema = ScriptShape.superRefine(checkReferences);

export type ScriptV1 = z.infer<typeof ScriptSchema>;
export type ScriptChapter = ScriptV1["chapters"][number];
export type ScriptVisual = ScriptBeat["visual"];
