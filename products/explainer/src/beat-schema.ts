import { z } from "zod";

/** The speech band (VT §5.3): how dense the narration over a beat may be. */
export const SPEECH_BANDS = ["story", "concept", "code", "takeaways", "held"] as const;

/** Where a beat sits in a block, for the planner's beat index (VT §5.4). */
export const BEAT_ROLES = ["open", "explain", "evidence", "navigate", "close"] as const;

/** Component maturity, as the components catalogue grades it; `gap` means no component exists yet. */
export const COMPONENT_MATURITIES = ["shipped", "spike", "doc", "gap"] as const;

/**
 * How an emphasis cue shows on screen. The beat's template offers some of these and picks per cue;
 * no treatment is the default, so emphasis does not look the same everywhere (plan, owner override 1).
 */
export const EMPHASIS_TREATMENTS = ["pointer", "highlight", "trace", "scale", "colour", "camera"] as const;

export const RECIPE_MAX_WORDS = 200;

const Kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case name");
const Seconds = z.number().positive();

const ComponentSchema = z
  .object({ name: z.string().min(1).optional(), maturity: z.enum(COMPONENT_MATURITIES) })
  .strict()
  .refine(({ name, maturity }) => (maturity === "gap") === (name === undefined), "a gap names no component; any other maturity names one");

/**
 * The emphasis mapping contract: `targets` are the beat's slot lists whose item ids a script cue
 * may name, and `treatments` are what the template may do to the named element.
 */
const EmphasisSchema = z
  .object({ targets: z.array(z.string().min(1)).min(1), treatments: z.array(z.enum(EMPHASIS_TREATMENTS)).min(1) })
  .strict();

/** One beat type's spec (VT §5.3 `BeatSpec`): the packet the builder gets, and the slots it fills. */
export const BeatSpecSchema = z
  .object({
    schema: z.literal("beat-spec/v1"),
    type: Kebab,
    summary: z.string().min(1),
    role: z.enum(BEAT_ROLES),
    component: ComponentSchema,
    slots: z.string().min(1),
    speech: z.object({ band: z.enum(SPEECH_BANDS) }).strict(),
    durationS: z.tuple([Seconds, Seconds, Seconds]),
    preset: z.boolean(),
    emphasis: EmphasisSchema.optional(),
    recipe: z.string().min(1),
    examples: z.array(z.object({ incorrect: z.string().min(1), correct: z.string().min(1) }).strict()).optional(),
  })
  .strict();

export type BeatSpec = z.infer<typeof BeatSpecSchema>;
export type SpeechBand = (typeof SPEECH_BANDS)[number];
export type EmphasisTreatment = (typeof EMPHASIS_TREATMENTS)[number];
