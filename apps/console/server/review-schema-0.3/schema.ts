// Vendored from titan-design packages/review-schema/src/schema.ts @ 4fcb3827a72cacf1f81a356bad32630e1f39f9e6 (tag
// review-schema-v0.3.0), byte-for-byte below this header, because 0.3.0 is not on npm (TD-805). TP-3232 deletes this
// directory when it installs the release. Never edit: re-vendor from a tag.
import { z } from 'zod'
import { BLIND_CHOICES, BlindPairSchema, audioDuration, audioPath } from './audio.ts'
import { SHIP_OPTIONS, contractProblems, duplicates, type Problem } from './contract.ts'
import { LOCK_AXES } from './locks.ts'
import { FrameReferenceSchema, MotionSchema, ScaleReferenceSchema, mediaProblems } from './media.ts'
import { CompareSchema, EvidenceTableSchema, OptionDetailSchema, packetProblems } from './packet.ts'

export const MANIFEST_SCHEMA_ID = 'titan-review/round@2'
/** A round written before the review contract: the page still reads it, the CLI refuses it. */
export const LEGACY_MANIFEST_SCHEMA_ID = 'titan-review/round@1'
export const FEEDBACK_SCHEMA_ID = 'titan-review/feedback@1'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'letters, digits, _ and - only')
const argValue = z.union([z.string(), z.number(), z.boolean()])
const scope = z.enum(['variant', 'round'])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** True only for http(s) URLs whose host is the local machine (any port). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return (protocol === 'http:' || protocol === 'https:') && LOOPBACK_HOSTS.has(hostname)
  } catch {
    return false
  }
}

// Storybook story ids are always `<component>--<story>` (Storybook docs: toId).
const storyId = z.string().regex(/^[a-z0-9-]+--[a-z0-9-]+$/, 'storybook id shape: component--story')

// Skips the loopback check when the url itself already failed z.url(), so an invalid
// url reports once, not twice.
const storybookUrl = z.url({ protocol: /^https?$/ }).check((ctx) => {
  if (ctx.issues.length === 0 && !isLoopbackUrl(ctx.value))
    ctx.issues.push({
      code: 'custom',
      message: `only loopback Storybook hosts (127.0.0.1, localhost, [::1]) are allowed: ${ctx.value}`,
      input: ctx.value,
    })
})

export const AUTO_HEIGHT = 'auto'

/**
 * A round without sections shows every frame on one page, so it stays small. A sectioned round
 * pages by section (or PR group) and mounts each frame only as it nears the viewport, so its
 * size is not capped.
 */
const MAX_VARIANTS = 12

/** A frame height in CSS px, or "auto" to size the frame to its story's content. */
const frameHeight = z.union([z.number().int().min(120).max(4000), z.literal(AUTO_HEIGHT)])

// Relative to the round file, never absolute and never through `..`; load time checks the rest.
const imagePath = z
  .string()
  .regex(
    /^(?![/\\]|[A-Za-z]:)(?!(.*[/\\])?\.\.([/\\]|$)).+\.[Pp][Nn][Gg]$/,
    'a .png path relative to the round file, without .. segments'
  )

// A recorded clip, under the same path rules as an image; load time checks the container.
const clipPath = z
  .string()
  .regex(
    /^(?![/\\]|[A-Za-z]:)(?!(.*[/\\])?\.\.([/\\]|$)).+\.(?:[Mm][Pp]4|[Ww][Ee][Bb][Mm])$/,
    'an .mp4 or .webm path relative to the round file, without .. segments'
  )

/** How a frame differs from main, in reg-cli's classes; absent when the round does not say. */
export const FRAME_CHANGES = ['changed', 'new', 'removed', 'unchanged'] as const

const SOURCES = ['storyId', 'image', 'clip', 'audio'] as const

/** A frame is a Storybook story, a static PNG, a recorded clip or a sound: exactly one of the four. */
export const VariantSchema = z
  .object({
    key: id,
    storyId: storyId.optional(),
    image: imagePath.optional(),
    clip: clipPath.optional(),
    /** A sound to listen to, played with loop and scrub; it needs its `transcript`. */
    audio: audioPath.optional(),
    /** What an audio frame says, shown under its player. */
    transcript: z.string().min(1).optional(),
    /** An audio frame's length, when the round wants it stated; the file is the authority. */
    durationMs: audioDuration.optional(),
    /** How the frame moves; an animation is reviewed playing, never as sampled states. */
    motion: MotionSchema.optional(),
    /** A size question's candidates, rendered together in one full-size frame. */
    scale: ScaleReferenceSchema.optional(),
    /** An image or clip that is a true-size frame, checked at load and drawn with a ladder. */
    frameReference: FrameReferenceSchema.optional(),
    label: z.string().min(1),
    args: z.record(z.string(), argValue).optional(),
    globals: z.record(z.string(), argValue).optional(),
    height: frameHeight.optional(),
    /** One variant shown in several views (themes, sizes, states): every view shares this id. */
    variantUnit: id.optional(),
    /** The column this frame's variant unit stands in when alternates are compared side by side. */
    alternate: id.optional(),
    change: z.enum(FRAME_CHANGES).optional(),
    /** The same frame rendered from the PR's base, so a Diff view sets base beside head. */
    baseImage: imagePath.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (SOURCES.filter((source) => v[source] !== undefined).length !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'a variant has exactly one of storyId, image, clip or audio',
      })
    for (const [field, message] of mediaProblems(v))
      ctx.addIssue({ code: 'custom', path: [field], message })
    if (v.storyId !== undefined) return
    for (const field of ['args', 'globals'] as const)
      if (v[field] !== undefined)
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} need a storyId variant` })
  })

const repoShape = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name')
const prPage = z.string().regex(/^[^/\s#]+\/[^/\s#]+#[1-9][0-9]*$/, 'must be owner/name#pr')

/**
 * What a topic key marks: `ask:` is the same question across rounds (by default
 * `ask:<unit>/<questionId>`); `component:`, `token:` and `topic:` mark a shared component,
 * token or topic, so a dashboard can group questions from different rounds.
 */
export const TOPIC_PREFIXES = ['ask', 'component', 'token', 'topic'] as const

const topicKey = z
  .string()
  .regex(
    new RegExp(`^(${TOPIC_PREFIXES.join('|')}):\\S+$`),
    'a topic is ask:, component:, token: or topic: then a name without spaces'
  )

/**
 * What answering a question decides: `iterate` picks among design alternates, `ship` approves
 * a finished change (a merge-bound question is always `ship`), `decide` is a choice no frame shows.
 */
export const DECISION_KINDS = ['iterate', 'ship', 'decide'] as const

/** What picking an option means for its PR's Ship: `changes` withholds Ship until a fix round. */
export const OPTION_OUTCOMES = ['accept', 'changes', 'neutral'] as const

/** A token a question's answer would decide; leaving `mode` out means both modes. */
const touchedToken = z
  .object({ name: z.string().min(1), mode: z.enum(['light', 'dark']).optional() })
  .strict()

/**
 * What a question with no PR diff would decide: the tokens, components and axis a lock check reads
 * (`build --locks`). A question on a PR page needs none; its PR head's footprint stands for it.
 */
export const QuestionTouchesSchema = z
  .object({
    tokens: z.array(touchedToken),
    components: z.array(z.string().min(1)).default([]),
    axis: z.enum(LOCK_AXES).optional(),
  })
  .strict()

const questionBase = {
  id,
  prompt: z.string().min(1),
  required: z.boolean().optional(),
  scope: scope.optional(),
  /** The PR this question is about, as `owner/name#pr`; a question with no page is on the general page. */
  page: prPage.optional(),
  /** The keys this question shares with questions in other rounds. */
  topics: z.array(topicKey).optional(),
  /**
   * The frames this question asks about, by variant key. The page renders them directly above
   * the question; they must sit in the question's own section. Absent: today's placement.
   */
  frames: z.array(id).min(1).optional(),
  decision: z.enum(DECISION_KINDS).optional(),
  touches: QuestionTouchesSchema.optional(),
}

/** Which variant each option stands for, so one click answers and picks the variant. */
const optionVariants = z.record(z.string(), id).optional()

/** Each option's outcome, by option text; an option it does not name has no declared outcome. */
const outcomes = z.record(z.string(), z.enum(OPTION_OUTCOMES)).optional()

/** A decision packet: each option's pros and cons by option text, measured tables, a viewer. */
const packet = {
  optionDetails: z.record(z.string(), OptionDetailSchema).optional(),
  evidence: z.array(EvidenceTableSchema).min(1).optional(),
  compare: CompareSchema.optional(),
}

/** Our answer to a question, hidden from the owner until they answer it themselves. */
export const RecommendationSchema = z
  .object({
    answer: z.union([z.string(), z.array(z.string()).min(1), z.number()]),
    rationale: z.string().min(1),
    confidence: z.number().min(0).max(1),
    /** The recommender: an agent name or "design-coord". */
    by: z.string().min(1),
    /** Where the recommended answer is weakest (markdown); hidden with the recommendation. */
    weakPoint: z.string().regex(/\S/, 'a weak point is not blank').optional(),
    /** The option to take if the recommended one fails: one of the options, not the answer. */
    fallback: z.string().optional(),
  })
  .strict()
const recommendation = RecommendationSchema.optional()

/** When the page shows a recommendation: once its question is answered, or from the start. */
const RECOMMENDATION_MODES = ['after-answer', 'shown'] as const

const sha40 = z.string().regex(/^[0-9a-f]{40}$/, 'must be 40 lower-case hex characters')

/** The PR head a pick-one is about, and the options that agree with merging it at that head. */
const MergeBindingSchema = z
  .object({
    repo: repoShape,
    pr: z.number().int().positive(),
    headSha: sha40,
    ship: z.array(z.string()).min(1),
  })
  .strict()

const PickOneSchema = z
  .object({
    ...questionBase,
    kind: z.literal('pick-one'),
    options: z.array(z.string()).min(2),
    /**
     * The option that is this round's own revision request. A required pick-one otherwise gets a
     * built-in "None of these, request a revision"; naming the author's own option here suppresses
     * it, and picking that option is recorded as a revision request, not a pick.
     */
    revisionOption: z.string().optional(),
    optionVariants,
    outcomes,
    ...packet,
    /** The option the PR at its head already implements; a pick that differs withholds Ship. */
    implemented: z.string().optional(),
    recommendation,
    /** The changed part an answer signs off, so no answer approves a whole PR at once. */
    signsOff: z.string().min(1).optional(),
    merge: MergeBindingSchema.optional(),
  })
  .strict()
const PickManySchema = z
  .object({
    ...questionBase,
    kind: z.literal('pick-many'),
    options: z.array(z.string()).min(1),
    optionVariants,
    outcomes,
    ...packet,
    /** The options the PR at its head already implements; a different set withholds Ship. */
    implemented: z.array(z.string()).min(1).optional(),
    recommendation,
  })
  .strict()
const ScaleSchema = z
  .object({
    ...questionBase,
    kind: z.literal('scale'),
    min: z.number().int(),
    max: z.number().int(),
    recommendation,
  })
  .strict()
  .refine((q) => q.min < q.max, { message: 'scale min must be below max' })
const TextSchema = z.object({ ...questionBase, kind: z.literal('text') }).strict()

/**
 * A blind listening test: each pair is played as A and B in an order seeded per round (`seed`,
 * else the unit, round and id), the owner picks one per pair, and the engines are revealed only
 * after the round is sent. The server never sends a take's engine or path to the page.
 */
const BlindAbSchema = z
  .object({
    ...questionBase,
    kind: z.literal('blind-ab'),
    pairs: z.array(BlindPairSchema).min(1),
    seed: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    for (const pair of duplicates(q.pairs.map((p) => p.id)))
      ctx.addIssue({ code: 'custom', path: ['pairs'], message: `pair ${pair} repeats` })
  })

export const QuestionSchema = z.discriminatedUnion('kind', [
  PickOneSchema,
  PickManySchema,
  ScaleSchema,
  TextSchema,
  BlindAbSchema,
])

const SIGNS_OFF = 'a pick-one question names the changed part it signs off (signsOff)'

const ContractQuestionSchema = z.discriminatedUnion('kind', [
  PickOneSchema.extend({ signsOff: z.string({ error: SIGNS_OFF }).regex(/\S/, SIGNS_OFF) }),
  PickManySchema,
  ScaleSchema,
  TextSchema,
  BlindAbSchema,
])

export const THEME_MODES = ['light', 'dark'] as const
const themeMode = z.enum(THEME_MODES)
/** WCAG check kinds; `REQUIRED_RATIO` in contrast.ts must name a threshold for each. */
export const CHECK_KINDS = ['text', 'large-text', 'non-text'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]
const checkKind = z.enum(CHECK_KINDS)
const NAMES_ELEMENT =
  'a known defect names one element: its data-testid, or the full selector build printed'

/** Where a known miss is fixed: the primitive or token task that owns it, or the component. */
const DEFECT_ROUTE = /^([A-Z][A-Z0-9]*-[0-9]+[a-z]?|component)$/

/** A contrast miss the round ships knowingly. It is reported with its route, never hidden. */
export const KnownDefectSchema = z
  .object({
    variant: id.optional(),
    mode: z.enum(THEME_MODES, { error: 'a known defect names its mode: light or dark' }),
    kind: z.enum(CHECK_KINDS, {
      error: 'a known defect names its kind: text, large-text or non-text',
    }),
    /** The failing element's own data-testid, or the full selector build printed, exactly. */
    element: z.string({ error: NAMES_ELEMENT }).min(1, NAMES_ELEMENT),
    /** The recorded contrast of the miss. When set, a finding at or above it is excused and one below it blocks. */
    minRatio: z.number().min(1).max(21).optional(),
    /** Renamed to minRatio: a higher ratio is better, so the old name described the bound backwards. */
    maxRatio: z
      .never({
        error: 'maxRatio was renamed minRatio: it is the recorded ratio, and a lower one blocks',
      })
      .optional(),
    route: z.string().regex(DEFECT_ROUTE, 'a task id such as TD-490, or "component"'),
    reason: z.string().min(1),
  })
  .strict()

/** An image variant's ratio, measured by the round builder because the DOM cannot be. */
const ImageMeasurementSchema = z
  .object({
    variant: id,
    mode: themeMode,
    kind: checkKind,
    element: z.string().min(1),
    ratio: z.number().min(1).max(21),
    /** How it was measured (a tool, a colour picker on the PNG); the record of the number. */
    source: z.string().min(1),
  })
  .strict()

const UnmeasuredSchema = z
  .object({ variant: id, mode: themeMode, reason: z.string().min(1) })
  .strict()

/** The contrast gate's declarations for the frames of a section, or of the whole round. */
export const ContrastDeclarationsSchema = z
  .object({
    knownDefects: z.array(KnownDefectSchema).default([]),
    measured: z.array(ImageMeasurementSchema).default([]),
    unmeasured: z.array(UnmeasuredSchema).default([]),
  })
  .strict()

/** A miss a round was served with anyway, copied from contrast.json. */
const OverriddenMissSchema = z
  .object({
    variant: z.string(),
    element: z.string(),
    mode: themeMode,
    kind: checkKind,
    ratio: z.number(),
    required: z.number(),
  })
  .strict()

/** A round served without a passing contrast gate: why, what the gate said, what it missed. */
export const ContrastOverrideSchema = z
  .object({
    reason: z.string().min(1),
    problem: z.string().min(1),
    failures: z.array(OverriddenMissSchema).default([]),
  })
  .strict()

/**
 * What a section's frames are: a CHOICE among variants that differ only in the property
 * decided, or the STATES of one design, which asks no choice.
 */
export const STRIP_KINDS = ['CHOICE', 'STATES'] as const

const SETTLED_CITE =
  'a settled part names what settles it (cite): a convention, a lint rule, a sibling API or an earlier decision'

/** A code pane's language, as the class on its code element (`language-ts`). */
const partLang = z.string().regex(/^[a-z0-9+#-]{1,20}$/i, 'a language name such as ts or diff')

/**
 * One prop, rename, default or meaning a section changes. An unsettled part is what a pick-one
 * signs off; a settled one is FYI and carries the cite that settles it.
 */
export const PartSchema = z
  .object({
    id,
    label: z.string().min(1),
    /** The code as it is now; absent for something new. */
    current: z.string().optional(),
    proposed: z.string().min(1),
    lang: partLang.optional(),
    settled: z
      .object({ cite: z.string({ error: SETTLED_CITE }).regex(/\S/, SETTLED_CITE) })
      .strict()
      .optional(),
  })
  .strict()

/** One group of frames with the question(s) those frames answer, in reading order. */
export const SectionSchema = z
  .object({
    id,
    title: z.string().min(1),
    /** What this section asks the owner to decide. */
    deciding: z.string().optional(),
    /** The diff against the last approved state. */
    changed: z.string().optional(),
    /** What is shown for context only and is out of scope. */
    context: z.string().optional(),
    /** The changed parts as code: each pick-one's signsOff names one of these by id. */
    parts: z.array(PartSchema).min(1).optional(),
    kind: z.enum(STRIP_KINDS).optional(),
    questionIds: z.array(id).default([]),
    variantKeys: z.array(id).default([]),
    /** Frames shown elsewhere that also bear on this section; rendered as a link, not a copy. */
    seeAlso: z.array(id).default([]),
    height: frameHeight.optional(),
    contrast: ContrastDeclarationsSchema.optional(),
  })
  .strict()

const sectionText = (message: string) => z.string({ error: message }).regex(/\S/, message)

const ContractSectionSchema = SectionSchema.extend({
  deciding: sectionText('a section says what it asks the owner to decide (deciding)'),
  changed: sectionText('a section says what changed since the last approved state (changed)'),
  context: sectionText('a section says what it shows for context only, out of scope (context)'),
})

function sectionProblems(m: {
  variants: { key: string }[]
  questions: { id: string }[]
  sections?: { id: string; variantKeys: string[]; questionIds: string[]; seeAlso: string[] }[]
}): string[] {
  if (!m.sections) return []
  const keys = new Set(m.variants.map((v) => v.key))
  const ids = new Set(m.questions.map((q) => q.id))
  const unknown = m.sections.flatMap((s) => [
    ...s.variantKeys
      .filter((k) => !keys.has(k))
      .map((k) => `section ${s.id}: unknown variant ${k}`),
    ...s.seeAlso.filter((k) => !keys.has(k)).map((k) => `section ${s.id}: unknown variant ${k}`),
    ...s.questionIds
      .filter((q) => !ids.has(q))
      .map((q) => `section ${s.id}: unknown question ${q}`),
  ])
  const claimedTwice = [
    ...duplicates(m.sections.flatMap((s) => s.variantKeys)).map(
      (k) => `variant ${k} is in two sections`
    ),
    ...duplicates(m.sections.flatMap((s) => s.questionIds)).map(
      (q) => `question ${q} is in two sections`
    ),
  ]
  const dupeIds = duplicates(m.sections.map((s) => s.id)).map((s) => `duplicate section id ${s}`)
  return [...unknown, ...claimedTwice, ...dupeIds]
}

function optionVariantProblems(m: {
  variants: { key: string }[]
  questions: {
    id: string
    options?: string[]
    optionVariants?: Record<string, string>
    outcomes?: Record<string, string>
    implemented?: string | string[]
    revisionOption?: string
    merge?: { ship: string[] }
  }[]
}): string[] {
  const keys = new Set(m.variants.map((v) => v.key))
  return m.questions.flatMap((q) => [
    ...(q.revisionOption === undefined || q.options?.includes(q.revisionOption)
      ? []
      : [`question ${q.id}: revisionOption "${q.revisionOption}" is not one of its options`]),
    ...(q.merge?.ship ?? []).flatMap((option) => [
      ...(q.options?.includes(option)
        ? []
        : [`question ${q.id}: ship option "${option}" is not one of its options`]),
      ...(option === q.revisionOption
        ? [`question ${q.id}: ship option "${option}" is its revisionOption`]
        : []),
    ]),
    ...[q.implemented ?? []]
      .flat()
      .flatMap((option) => [
        ...(q.options?.includes(option)
          ? []
          : [`question ${q.id}: implemented option "${option}" is not one of its options`]),
        ...(option === q.revisionOption
          ? [`question ${q.id}: implemented option "${option}" is its revisionOption`]
          : []),
      ]),
    ...Object.keys(q.outcomes ?? {})
      .filter((option) => !q.options?.includes(option))
      .map(
        (option) => `question ${q.id}: outcome for "${option}", which is not one of its options`
      ),
    ...Object.entries(q.optionVariants ?? {}).flatMap(([option, key]) => [
      ...(q.options?.includes(option)
        ? []
        : [`question ${q.id}: "${option}" is not one of its options`]),
      ...(keys.has(key)
        ? []
        : [`question ${q.id}: optionVariants points at unknown variant ${key}`]),
    ]),
  ])
}

interface Anchoring {
  variants: { key: string }[]
  questions: { id: string; frames?: string[] }[]
  sections?: { id: string; questionIds: string[] }[]
}

/**
 * Each anchored frame is a known variant, named once, on a question in a section. Where the frames
 * sit, and that a frame anchors one question, is `lintRound`'s to check.
 */
function anchorProblems(m: Anchoring): string[] {
  const keys = new Set(m.variants.map((v) => v.key))
  const inSection = new Set(m.sections?.flatMap((s) => s.questionIds))
  return m.questions.flatMap((q) => {
    if (!q.frames) return []
    const placement = !m.sections
      ? [`question ${q.id}: frames need sections; group the round into sections`]
      : inSection.has(q.id)
        ? []
        : [`question ${q.id}: it has frames but is in no section, so none can sit above it`]
    return [
      ...q.frames.filter((k) => !keys.has(k)).map((k) => `question ${q.id}: unknown frame ${k}`),
      ...[...new Set(duplicates(q.frames))].map((k) => `question ${q.id}: frame ${k} repeats`),
      ...placement,
    ]
  })
}

type Declarations = z.output<typeof ContrastDeclarationsSchema>

function declaredVariants(decl: Declarations): { field: string; variant: string }[] {
  return [
    ...decl.knownDefects.flatMap((d) =>
      d.variant ? [{ field: 'knownDefects', variant: d.variant }] : []
    ),
    ...decl.measured.map((d) => ({ field: 'measured', variant: d.variant })),
    ...decl.unmeasured.map((d) => ({ field: 'unmeasured', variant: d.variant })),
  ]
}

/** A declaration names a frame of its own section (or any frame, at round level). */
function contrastProblems(m: {
  variants: { key: string; storyId?: string }[]
  contrast?: Declarations
  sections?: { id: string; variantKeys: string[]; contrast?: Declarations }[]
}): string[] {
  // An image or a clip has no DOM to measure, so only it takes a measured ratio.
  const withoutDom = new Set(m.variants.filter((v) => v.storyId === undefined).map((v) => v.key))
  const scopes = [
    { where: 'contrast', keys: new Set(m.variants.map((v) => v.key)), decl: m.contrast },
    ...(m.sections ?? []).map((s) => ({
      where: `section ${s.id} contrast`,
      keys: new Set(s.variantKeys),
      decl: s.contrast,
    })),
  ]
  return scopes.flatMap(({ where, keys, decl }) =>
    (decl ? declaredVariants(decl) : []).flatMap(({ field, variant }) => {
      if (!keys.has(variant)) return [`${where}.${field}: ${variant} is not a frame here`]
      if (field !== 'knownDefects' && !withoutDom.has(variant))
        return [
          `${where}.${field}: ${variant} is a story; only an image or clip variant is ${field}`,
        ]
      return []
    })
  )
}

type Recommendable = Exclude<Question, { kind: 'text' | 'blind-ab' }>

function recommendationProblem(q: Recommendable, answer: Recommendation['answer']) {
  if (q.kind === 'scale')
    return Number.isInteger(answer) && Number(answer) >= q.min && Number(answer) <= q.max
      ? null
      : 'is not on its scale'
  const picks = Array.isArray(answer) ? answer : [answer]
  if (Array.isArray(answer) !== (q.kind === 'pick-many'))
    return q.kind === 'pick-many' ? 'is not a list of its options' : 'is not one of its options'
  if (!picks.every((p) => typeof p === 'string' && q.options.includes(p)))
    return 'is not among its options'
  return new Set(picks).size === picks.length ? null : 'repeats an option'
}

function recommendationProblems(m: { questions: z.output<typeof QuestionSchema>[] }): string[] {
  return m.questions.flatMap((q) => {
    const problem =
      takesRecommendation(q) &&
      q.recommendation &&
      recommendationProblem(q, q.recommendation.answer)
    return problem ? [`question ${q.id}: the recommended answer ${problem}`] : []
  })
}

/** What the Storybook was built from; written by the build, never by hand. */
const BuildProvenanceSchema = z.object({ mainSha: sha40, mergeSha: sha40 }).strict()

/** The base PR a stacked round renders beneath its own; its frames are context, not under review. */
export const StackedOnSchema = z
  .object({ repo: repoShape, pr: z.number().int().positive(), headSha: sha40 })
  .strict()

/** The kind of change a PR makes, as its header names it. */
export const PR_KINDS = ['feature', 'correctness', 'refactor', 'security', 'docs'] as const

/** A path the PR changes, and how. */
const PrFileSchema = z
  .object({
    path: z.string().min(1),
    status: z.enum(['added', 'modified', 'removed', 'renamed']).optional(),
  })
  .strict()

/** The task a PR implements, and what "done" means for it. */
const PrTaskSchema = z
  .object({ id: z.string().min(1), title: z.string().optional(), doneWhen: z.string().optional() })
  .strict()

/**
 * One PR at its head and the sections about it, which a page shows together, Ship last. A group's
 * own `stackedOn` names the base it renders on; groups in one round may sit on different bases. The
 * rest is read-only context a page shows beside the review: never a question.
 */
export const PrGroupSchema = z
  .object({
    pr: prPage,
    headSha: sha40,
    sectionIds: z.array(id).min(1),
    stackedOn: StackedOnSchema.optional(),
    title: z.string().min(1).optional(),
    kind: z.enum(PR_KINDS).optional(),
    /** The PR description, as markdown. */
    description: z.string().optional(),
    task: PrTaskSchema.optional(),
    /** A codewatch report on the PR, as markdown. */
    codewatch: z.string().optional(),
    files: z.array(PrFileSchema).optional(),
  })
  .strict()

type StackedGroup = { pr: string; stackedOn?: { repo: string; pr: number } }

/** `owner/name#n` of the base a PR group is stacked on, or undefined when it is not stacked. */
export const stackBase = (group: StackedGroup): string | undefined =>
  group.stackedOn && `${group.stackedOn.repo}#${group.stackedOn.pr}`

function stackProblems(groups: StackedGroup[]): string[] {
  const bases = new Map(groups.map((g) => [g.pr, stackBase(g)]))
  return groups.flatMap((g) => {
    const seen = [g.pr]
    for (let at = bases.get(g.pr); at !== undefined; at = bases.get(at)) {
      if (at === g.pr)
        return [`PR group ${g.pr} is stacked on itself: ${[...seen, at].join(' -> ')}`]
      if (seen.includes(at)) return []
      seen.push(at)
    }
    return []
  })
}

function prGroupProblems(m: {
  sections?: { id: string }[]
  prGroups?: (StackedGroup & { sectionIds: string[] })[]
}): string[] {
  if (!m.prGroups) return []
  if (!m.sections) return ['prGroups need sections; group the round into sections']
  const ids = new Set(m.sections.map((s) => s.id))
  return [
    ...stackProblems(m.prGroups),
    ...m.prGroups.flatMap((g) =>
      g.sectionIds.filter((s) => !ids.has(s)).map((s) => `PR group ${g.pr}: unknown section ${s}`)
    ),
    ...[...new Set(duplicates(m.prGroups.flatMap((g) => g.sectionIds)))].map(
      (s) => `section ${s} is in two PR groups`
    ),
    ...[...new Set(duplicates(m.prGroups.map((g) => g.pr)))].map((pr) => `PR ${pr} has two groups`),
  ]
}

const sameList = (a: string[] | undefined, b: string[]) =>
  a?.length === b.length && a.every((v, i) => v === b[i])

function shipQuestionProblems(q: z.output<typeof QuestionSchema>): string[] {
  if (q.kind !== 'pick-one' || !q.merge) return []
  const key = `${q.merge.repo}#${q.merge.pr}`
  return [
    ...(q.required === true ? [] : [`question ${q.id}: a merge-bound question must be required`]),
    ...(sameList(q.options, SHIP_OPTIONS)
      ? []
      : [
          `question ${q.id}: a merge-bound question's options must be exactly ${JSON.stringify(SHIP_OPTIONS)}`,
        ]),
    ...(sameList(q.merge.ship, ['Ship'])
      ? []
      : [`question ${q.id}: a merge-bound question's ship set must be exactly ["Ship"]`]),
    ...(q.page === key ? [] : [`question ${q.id}: a merge-bound question's page must be "${key}"`]),
    ...(q.decision === undefined || q.decision === 'ship'
      ? []
      : [`question ${q.id}: a merge-bound question's decision is ship, not ${q.decision}`]),
  ]
}

function mergeBindingProblems(m: { questions: z.output<typeof QuestionSchema>[] }): string[] {
  const bound = new Map<string, string[]>()
  for (const q of m.questions) {
    if (q.kind !== 'pick-one' || !q.merge) continue
    const key = `${q.merge.repo}#${q.merge.pr}`
    bound.set(key, [...(bound.get(key) ?? []), q.id])
  }
  return [
    ...m.questions.flatMap(shipQuestionProblems),
    ...[...bound]
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => `${key} is bound by more than one question: ${ids.join(', ')}`),
    ...m.questions.flatMap((q) =>
      q.page && !bound.has(q.page)
        ? [`question ${q.id}: page "${q.page}" has no ship/no-ship question`]
        : []
    ),
  ]
}

const ManifestObject = z
  .object({
    schema: z.enum([MANIFEST_SCHEMA_ID, LEGACY_MANIFEST_SCHEMA_ID]),
    unit: z.string().min(1),
    round: z.number().int().min(1),
    storybookUrl,
    context: z.string().optional(),
    widths: z.array(z.number().int().min(200).max(3840)).min(1),
    height: frameHeight.default(AUTO_HEIGHT),
    /** The ceiling an auto-sized frame stops at; taller stories scroll inside the frame. */
    maxHeight: z.number().int().min(120).max(4000).default(1200),
    /** Empty for a questions-only round; nothing has to stand in for a frame it does not have. */
    variants: z.array(VariantSchema),
    questions: z.array(QuestionSchema),
    sections: z.array(SectionSchema).min(1).optional(),
    recommendations: z.enum(RECOMMENDATION_MODES).default('after-answer'),
    /** Declarations that hold for every frame; a section's own hold for its frames. */
    contrast: ContrastDeclarationsSchema.optional(),
    /** Written by `--contrast-override` when the round is served ungated; never hand-written. */
    contrastOverride: ContrastOverrideSchema.optional(),
    build: BuildProvenanceSchema.optional(),
    stackedOn: StackedOnSchema.optional(),
    /** The PR groups, in any order; a section in none is not about a PR or is grouped by `page`. */
    prGroups: z.array(PrGroupSchema).min(1).optional(),
  })
  .strict()

function manifestProblems(m: z.output<typeof ManifestObject>): Problem[] {
  const dupes = (path: string, values: string[]) =>
    duplicates(values).length ? [{ path, message: `duplicate: ${duplicates(values)}` }] : []
  const at = (path: string, messages: string[]) => messages.map((message) => ({ path, message }))
  return [
    ...dupes(
      'variants',
      m.variants.map((v) => v.key)
    ),
    ...dupes(
      'questions',
      m.questions.map((q) => q.id)
    ),
    ...dupes('widths', m.widths.map(String)),
    ...(!m.sections && m.variants.length > MAX_VARIANTS
      ? at('variants', [
          `a round without sections holds at most ${MAX_VARIANTS} variants; group more into sections`,
        ])
      : []),
    ...at('sections', sectionProblems(m)),
    ...at('prGroups', prGroupProblems(m)),
    ...at('questions', [
      ...anchorProblems(m),
      ...optionVariantProblems(m),
      ...recommendationProblems(m),
      ...mergeBindingProblems(m),
      ...packetProblems(m),
    ]),
    ...at('contrast', contrastProblems(m)),
  ]
}

function addProblems(ctx: z.RefinementCtx, problems: Problem[]): void {
  for (const { path, message } of problems) ctx.addIssue({ code: 'custom', path: [path], message })
}

/** Reads any round the page can render, including one written before the review contract. */
export const ManifestSchema = ManifestObject.superRefine((m, ctx) =>
  addProblems(ctx, manifestProblems(m))
)

const LEGACY_REFUSED =
  `${LEGACY_MANIFEST_SCHEMA_ID} predates the review contract; migrate it to ${MANIFEST_SCHEMA_ID} ` +
  '(sections with deciding, changed and context; a kind on each strip; signsOff on pick-one)'

/**
 * The round the CLI serves and builds: every section says what it decides, what changed and
 * what is context only, every strip is a CHOICE or STATES, every pick-one names what it signs off.
 */
export const RoundSchema = ManifestObject.extend({
  schema: z.literal(MANIFEST_SCHEMA_ID, { error: LEGACY_REFUSED }),
  questions: z.array(ContractQuestionSchema),
  sections: z
    .array(ContractSectionSchema, { error: 'a round needs a sections array' })
    .min(1, 'a round groups its questions into sections'),
}).superRefine((m, ctx) => addProblems(ctx, [...manifestProblems(m), ...contractProblems(m)]))

/** A comment the human left on a frame that a section pointed at this question. */
const variantCommentSchema = z.object({ key: z.string(), comment: z.string() }).strict()

const answerSchema = z
  .object({
    questionId: z.string(),
    pick: z.string().optional(),
    /** The owner rejected every option; `comment` then says what to change. Never set with `pick`. */
    revisionRequested: z.literal(true).optional(),
    picks: z.array(z.string()).optional(),
    value: z.number().optional(),
    text: z.string().optional(),
    comment: z.string().optional(),
    variantComments: z.array(variantCommentSchema).optional(),
    /** The manifest's recommendation for this question, echoed so a report needs no manifest. */
    recommendation: RecommendationSchema.optional(),
    /** Whether the owner's answer equals the recommendation's (pick-many: the same set). */
    agreed: z.boolean().optional(),
    /** The owner's notes on options other than (or as well as) the one they picked. */
    optionNotes: z
      .array(z.object({ option: z.string(), note: z.string().min(1) }).strict())
      .optional(),
    /** The picked option's `after` text, echoed so the agent acting on the pick needs no manifest. */
    after: z.string().optional(),
    /**
     * The answer was given while the recommendation was visible: after a reveal, or in a `shown`
     * round. Absent means blind. Only on a question with a recommendation and an answer.
     */
    recommendationSeen: z.literal(true).optional(),
    /**
     * A blind-ab answer: the position picked in each pair. The page sends `choice` only; the
     * server adds the `engine` it maps to after the round is sent.
     */
    pairs: z
      .array(
        z
          .object({
            pair: z.string(),
            choice: z.enum(BLIND_CHOICES),
            engine: z.string().optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict()

const targetSchema = z
  .object({
    testId: z.string().optional(),
    role: z.string().optional(),
    text: z.string().optional(),
  })
  .strict()

export const AnnotationSchema = z
  .object({
    id: z.string(),
    width: z.number().int(),
    x: z.number(),
    y: z.number(),
    xPct: z.number().min(0).max(1),
    yPct: z.number().min(0).max(1),
    target: targetSchema.optional(),
    note: z.string(),
  })
  .strict()

export const VerdictSchema = z.enum(['chosen', 'rejected', 'maybe']).nullable()

const variantFeedbackSchema = z
  .object({
    key: z.string(),
    /** Echoes the frame's source: `storyId`, `image`, `clip` or `audio`, whichever it has. */
    storyId: z.string().optional(),
    image: z.string().optional(),
    clip: z.string().optional(),
    audio: z.string().optional(),
    verdict: VerdictSchema,
    comment: z.string(),
    annotations: z.array(AnnotationSchema),
    /** The questions whose section showed this frame, so a comment on it has an address. */
    relatedQuestionIds: z.array(z.string()).optional(),
  })
  .strict()

export const FeedbackSchema = z
  .object({
    schema: z.literal(FEEDBACK_SCHEMA_ID),
    unit: z.string(),
    round: z.number().int(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    submittedAt: z.iso.datetime(),
    answers: z.array(answerSchema),
    variants: z.array(variantFeedbackSchema),
    general: z.string(),
    /** Present only on a deliberate partial submit: every question it left unanswered. */
    unansweredQuestionIds: z.array(z.string()).min(1).optional(),
    /** The round's contrast override, so the record of an ungated round outlives the serve. */
    contrastOverride: ContrastOverrideSchema.optional(),
  })
  .strict()

export type ManifestInput = z.input<typeof ManifestSchema>
export type Manifest = z.output<typeof ManifestSchema>
export type Variant = Manifest['variants'][number]
export type StoryVariant = Variant & { storyId: string }
export type ImageVariant = Variant & { image: string }
export type ClipVariant = Variant & { clip: string }
export type AudioVariant = Variant & { audio: string; transcript: string }
export type BlindAbQuestion = Extract<Question, { kind: 'blind-ab' }>
export type Question = Manifest['questions'][number]
export type TopicPrefix = (typeof TOPIC_PREFIXES)[number]
export type StackedOn = z.infer<typeof StackedOnSchema>
export type PrGroup = z.infer<typeof PrGroupSchema>
export type PrKind = (typeof PR_KINDS)[number]
export type QuestionTouches = z.output<typeof QuestionTouchesSchema>
export type DecisionKind = (typeof DECISION_KINDS)[number]
export type OptionOutcome = (typeof OPTION_OUTCOMES)[number]
export type FrameChange = (typeof FRAME_CHANGES)[number]
export type Section = z.output<typeof SectionSchema>
export type Part = z.output<typeof PartSchema>
export type StripKind = (typeof STRIP_KINDS)[number]
export type FrameHeight = number | typeof AUTO_HEIGHT
export type Feedback = z.infer<typeof FeedbackSchema>
export type Answer = Feedback['answers'][number]
export type VariantFeedback = Feedback['variants'][number]
export type Annotation = z.infer<typeof AnnotationSchema>
export type Verdict = z.infer<typeof VerdictSchema>
export type Recommendation = z.infer<typeof RecommendationSchema>
export type ThemeMode = (typeof THEME_MODES)[number]
export type KnownDefect = z.infer<typeof KnownDefectSchema>
export type ContrastDeclarations = z.output<typeof ContrastDeclarationsSchema>
export type ContrastOverride = z.output<typeof ContrastOverrideSchema>

export function isStoryVariant(variant: Variant): variant is StoryVariant {
  return variant.storyId !== undefined
}

export function isImageVariant(variant: Variant): variant is ImageVariant {
  return variant.image !== undefined
}

export function isClipVariant(variant: Variant): variant is ClipVariant {
  return variant.clip !== undefined
}

/** The questions that may carry a recommendation: a text or blind-ab question takes none. */
export function takesRecommendation(
  q: Question
): q is Exclude<Question, { kind: 'text' | 'blind-ab' }> {
  return q.kind !== 'text' && q.kind !== 'blind-ab'
}

export function isAudioVariant(variant: Variant): variant is AudioVariant {
  return variant.audio !== undefined
}

// zod can't express the object-level loopback superRefine as JSON Schema; a pattern
// on the field is the closest honest approximation for schema consumers.
const LOOPBACK_URL_PATTERN = '^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]+)?(/.*)?$'

const NO_STORY_FIELDS = {
  anyOf: [{ required: ['args'] }, { required: ['globals'] }, { required: ['scale'] }],
}

const NO_FRAME_FIELDS = {
  anyOf: [...NO_STORY_FIELDS.anyOf, { required: ['frameReference'] }, { required: ['motion'] }],
}

// The variant superRefine (exactly one source; args, globals and scale only on stories; a frame
// reference only on images and clips; a clip declares its motion; audio names its transcript and
// neither moves nor sizes), as JSON Schema.
const VARIANT_SOURCE = {
  oneOf: [
    { required: ['storyId'], not: { required: ['frameReference'] } },
    { required: ['image'], not: NO_STORY_FIELDS },
    { required: ['clip', 'motion'], not: NO_STORY_FIELDS },
    { required: ['audio', 'transcript'], not: NO_FRAME_FIELDS },
  ],
}

// The contract's "a section with frames names its strip's kind", as JSON Schema.
const STRIP_NEEDS_KIND = {
  if: { required: ['variantKeys'], properties: { variantKeys: { minItems: 1 } } },
  then: { required: ['kind'] },
}

/** The round@2 contract, which is what an author writes against. */
export function manifestJsonSchema(): unknown {
  const schema = z.toJSONSchema(RoundSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as unknown as {
    properties: {
      storybookUrl: Record<string, unknown>
      variants: { items: Record<string, unknown> }
      sections: { items: Record<string, unknown> }
    }
  }
  schema.properties.storybookUrl.pattern = LOOPBACK_URL_PATTERN
  Object.assign(schema.properties.variants.items, VARIANT_SOURCE)
  Object.assign(schema.properties.sections.items, STRIP_NEEDS_KIND)
  return schema
}

export function feedbackJsonSchema(): unknown {
  return z.toJSONSchema(FeedbackSchema, { unrepresentable: 'any' })
}
