import { z } from "zod";

/** The profile families of the video-profiles plan (§B): what a profile's video reviews or briefs. */
export const PROFILE_FAMILIES = ["review-pr", "review-paper", "review-repo", "briefing"] as const;

/**
 * Series fields (plan §A.4): what a video shares with, or must change from, the previous videos of
 * its profile. The variety lints (TP-4019) key on these names.
 */
export const SERIES_FIELDS = [
  "frame-chrome",
  "intro-outro",
  "chapter-rail",
  "house-look",
  "captions",
  "voice",
  "structure",
  "hook-kind",
  "chapter-labels",
  "close-kind",
  "function-mix",
  "component-histogram",
  "framing-sequence",
  "signature-layer",
  "style-pack",
  "stock-lines",
  "lead-story",
  "featured-visual",
] as const;

export type ProfileFamily = (typeof PROFILE_FAMILIES)[number];
export type SeriesField = (typeof SERIES_FIELDS)[number];

const Kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case name");
const Seconds = z.number().int().nonnegative();
const Band = z.tuple([Seconds, Seconds]);

/** `labels` is how the block's beats write `visual.labels` so the host bridge's views fire; the script prompt carries it. */
const BlockSchema = z
  .object({ id: Kebab, goal: z.string().min(1), seconds: Band, beats: z.array(Kebab).min(1), require: z.array(Kebab).optional(), labels: z.string().min(1).optional() })
  .strict();

/** One heuristic row: a registered structure, and the profile's own wording of its fit question. */
const HeuristicRowSchema = z.object({ macro: Kebab, ask: z.string().min(1) }).strict();

/**
 * A beat system the profile plays inside one macro: over every block of the macro, or only inside
 * `blocks`, as a segment nests in a larger order. The audition picks among the systems a macro lists.
 */
const SystemBindingSchema = z.object({ system: Kebab, macro: Kebab, blocks: z.array(Kebab).min(1).optional() }).strict();

const Systems = z.array(SystemBindingSchema).default([]);

/** A fixed structure plays its blocks in the listed order: chapters are the viewer's navigation (VT §2.2). */
const FixedStructureSchema = z.object({ order: z.literal("fixed"), macro: Kebab, blocks: z.array(BlockSchema).min(1), systems: Systems }).strict();

/**
 * A heuristic structure takes the first heuristic row whose registered structure fits the material
 * (story-structure §4). Each macro names a structure in `doctrine/structures/`.
 */
const HeuristicStructureSchema = z
  .object({
    order: z.literal("heuristic"),
    blocks: z.array(BlockSchema).min(1),
    macros: z.record(Kebab, z.array(Kebab).min(1)),
    heuristic: z.array(HeuristicRowSchema).min(1),
    fallback: Kebab,
    systems: Systems,
  })
  .strict();

const Share = z.number().min(0).max(1);

/** The packs a profile's videos may render in; `house` is the one it repeats when it has a house look. */
const StylesSchema = z.object({ allow: z.array(Kebab).min(1), house: Kebab.optional() }).strict();

/**
 * The profile's voice band (plan §A.4, W13/W14): a Kokoro voice id and its speed. The voice varies
 * per profile, not per video, to break the series tell without buying a premium voice.
 */
const VoiceBandSchema = z
  .object({ id: z.string().regex(/^[a-z]{2}_[a-z]+$/, "expected a Kokoro voice id such as af_heart"), rate: z.number().min(0.5).max(2) })
  .strict();

/**
 * Who a profile's videos are for: `public` ones are watched by choice, `assigned` ones by a viewer the work was handed
 * to. A profile that names none is `assigned`: every shipped audience pack but one is the owner's, and a public video
 * already needs an owner ask per publish, so public is the opt-in.
 */
export const AUDIENCE_KINDS = ["public", "assigned"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

const RuntimeSchema = z.object({ targetS: Seconds, minS: Seconds, maxS: Seconds, splitAboveS: Seconds }).strict();
export type RuntimeBand = z.infer<typeof RuntimeSchema>;

/**
 * The band a profile with no `runtime` of its own runs in (owner decision 551): a public video is at most 6 min and
 * splits past it, an assigned one keeps the tour's 600 s.
 */
export const AUDIENCE_RUNTIME: Readonly<Record<AudienceKind, RuntimeBand>> = {
  public: { targetS: 240, minS: 120, maxS: 360, splitAboveS: 360 },
  assigned: { targetS: 600, minS: 480, maxS: 720, splitAboveS: 900 },
};

/**
 * One video type's profile (VT §5.3 plus plan §A.5). It carries no spend cap (owner Q5: exact cost
 * is tracked, with a runaway backstop only) and no signature requirement (the signature layer is a
 * pilot hypothesis, not a rule). Its runtime is resolved on parse: its own band wins over its audience's.
 */
export const TypeProfileSchema = z
  .object({
    schema: z.literal("type-profile/v1"),
    type: Kebab,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected a semver version"),
    family: z.enum(PROFILE_FAMILIES),
    intent: z.string().min(1),
    audience: z.object({ default: Kebab, allow: z.array(Kebab).min(1), kind: z.enum(AUDIENCE_KINDS).default("assigned") }).strict(),
    inputs: z.object({ adapters: z.array(z.string().min(1)), preconditions: z.array(Kebab) }).strict(),
    runtime: RuntimeSchema.optional(),
    structure: z.discriminatedUnion("order", [FixedStructureSchema, HeuristicStructureSchema]),
    cuts: z.array(z.object({ id: Kebab, type: Kebab.optional(), when: z.string().min(1), runtimeS: Band }).strict()).default([]),
    hook: z.string().min(1),
    ending: z.enum(["scorecard+button", "takeaways+button", "button"]),
    series: z.object({ mayRepeat: z.array(z.enum(SERIES_FIELDS)), mustVary: z.array(z.enum(SERIES_FIELDS)).min(1) }).strict(),
    audition: z.object({ k: z.number().int().min(3), storyboardOnly: z.literal(true) }).strict(),
    /** Where the script stage's spine comes from: `audition-pick` writes one from the pick; absent, the run is given one. */
    spine: z.object({ from: z.literal("audition-pick") }).strict().optional(),
    /** The host bridge this type renders through, `bridges/<name>.json` in the host's data dir; absent, the run data dir's `bridge.json`. */
    bridge: Kebab.optional(),
    layers: z.object({ customMin: z.number().int().nonnegative(), templateMaxShare: Share, componentMaxShare: Share }).strict(),
    variety: z.object({ window: z.number().int().positive(), minFramings: z.number().int().positive(), ngram: z.number().int().positive(), mode: z.enum(["warn", "gate"]) }).strict(),
    /** `pictureChangeMaxS` is the warn line, `pictureChangeFailS` the fail line; the qa stage's timing gates default the optional ones (TP-2669). */
    pacing: z
      .object({
        pictureChangeMaxS: z.number().positive(), pictureChangeFailS: z.number().positive().optional(), staticMaxS: z.number().positive(), held: Band, reHookS: Band,
        cueOnsetS: z.number().positive().optional(), readingCps: z.number().positive().optional(), readingMinS: z.number().positive().optional(),
      })
      .strict(),
    coverage: z.array(Kebab),
    publish: z.object({ ownerAskPerVideo: z.boolean(), checks: z.array(Kebab) }).strict().optional(),
    styles: StylesSchema,
    voice: VoiceBandSchema,
  })
  .strict()
  .transform((profile) => ({ ...profile, runtime: profile.runtime ?? AUDIENCE_RUNTIME[profile.audience.kind] }));

export type TypeProfile = z.infer<typeof TypeProfileSchema>;
export type ProfileBlock = z.infer<typeof BlockSchema>;
export type HeuristicStructure = z.infer<typeof HeuristicStructureSchema>;
export type SystemBinding = z.infer<typeof SystemBindingSchema>;
export type VoiceBand = z.infer<typeof VoiceBandSchema>;

/** An audience parameter pack (VT §5.2): who watches, and whether the video may leave the machine. */
export const AudiencePackSchema = z
  .object({
    schema: z.literal("audience-pack/v1"),
    id: Kebab,
    viewer: z.string().min(1),
    verdicts: z.enum(["titan-relative", "none"]),
    publishable: z.boolean(),
  })
  .strict();

export type AudiencePack = z.infer<typeof AudiencePackSchema>;
