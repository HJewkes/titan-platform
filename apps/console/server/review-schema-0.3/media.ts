// Vendored from titan-design packages/review-schema/src/media.ts @ 4fcb3827a72cacf1f81a356bad32630e1f39f9e6 (tag
// review-schema-v0.3.0), byte-for-byte below this header, because 0.3.0 is not on npm (TD-805). TP-3232 deletes this
// directory when it installs the release. Never edit: re-vendor from a tag.
import { z } from 'zod'

// Motion and scale on a frame (owner decision 339(2)): an animation is reviewed playing, with a
// scrubber, never as static samples; a size question is answered inside a full-size frame beside
// a reference ladder of known text sizes.

const argName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'a Storybook arg name')
const argValue = z.union([z.string(), z.number(), z.boolean()])

/** How a frame moves: a live story arg the page drives, or a recorded clip the page plays. */
export const MOTION_MECHANISMS = ['arg', 'clip'] as const

const playback = {
  /** Starts playing as the frame mounts. */
  autoplay: z.boolean().default(true),
  /** Starts again from the beginning at the end. */
  loop: z.boolean().default(true),
}

/**
 * A live story driven by one numeric arg, usually `progress` 0..1. Play sweeps the arg from `from`
 * to `to` over `durationMs`; the scrubber sets it directly. The page sends each value to the story
 * through Storybook's channel, so the story never reloads.
 */
export const ArgMotionSchema = z
  .object({
    mechanism: z.literal('arg'),
    arg: argName.default('progress'),
    from: z.number().default(0),
    to: z.number().default(1),
    durationMs: z.number().int().min(100).max(600_000),
    ...playback,
  })
  .strict()
  .refine((m) => m.from !== m.to, { message: 'a motion arg sweeps a range: from and to differ' })

/** A labelled moment in a clip; the page lists it under the clip, and a click seeks there. */
const KeyframeSchema = z
  .object({
    atMs: z.number().int().min(0).max(600_000),
    label: z.string().min(1).max(80),
  })
  .strict()

/**
 * A recorded clip (the variant's `clip`), played with the page's play, loop and scrub controls.
 * `keyframes` name its stages in time order; they sit beside the playing clip, never in its place.
 */
export const ClipMotionSchema = z
  .object({
    mechanism: z.literal('clip'),
    /** The clip's length, when the round wants it stated; the file is the authority. */
    durationMs: z.number().int().min(100).max(600_000).optional(),
    keyframes: z.array(KeyframeSchema).min(1).max(12).optional(),
    ...playback,
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const [i, k] of (m.keyframes ?? []).entries()) {
      const previous = m.keyframes?.[i - 1]
      if (previous && k.atMs <= previous.atMs)
        ctx.addIssue({
          code: 'custom',
          path: ['keyframes', i, 'atMs'],
          message: `keyframes run in time order: ${k.label} at ${k.atMs}ms follows ${previous.atMs}ms`,
        })
      if (m.durationMs !== undefined && k.atMs > m.durationMs)
        ctx.addIssue({
          code: 'custom',
          path: ['keyframes', i, 'atMs'],
          message: `keyframe ${k.label} at ${k.atMs}ms is past the clip's ${m.durationMs}ms`,
        })
    }
  })

export const MotionSchema = z.discriminatedUnion('mechanism', [ArgMotionSchema, ClipMotionSchema])

/** The frame a scale reference renders its candidates in: a 1080p video frame by default. */
export const DEFAULT_SCALE_FRAME = { width: 1920, height: 1080 } as const

/**
 * The reference ladder drawn beside the candidates. titan has no video type scale yet (its
 * Typography scale in packages/ui/src/theme/tokens/semantic.ts tops out at h1 = 56px, sized
 * for screens read at arm's length), so these are the owner's working sizes for 1080p video
 * from decision 339(2). A round with a real scale passes its own `ladder`.
 */
export const DEFAULT_SCALE_LADDER = [
  { label: 'caption', px: 24 },
  { label: 'body', px: 32 },
  { label: 'title', px: 64 },
  { label: 'display', px: 96 },
] as const

const LadderRungSchema = z
  .object({ label: z.string().min(1).max(40), px: z.number().positive().max(1000) })
  .strict()

const FrameSizeSchema = z
  .object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160),
  })
  .strict()

const ladder = z
  .array(LadderRungSchema)
  .min(1)
  .max(8)
  .default([...DEFAULT_SCALE_LADDER])

/**
 * A size question's candidate set: the story rendered once per value of `arg`, side by side in
 * one `frame`, beside the reference `ladder`. The page shows the frame fitted and at 1:1.
 */
export const ScaleReferenceSchema = z
  .object({
    arg: argName,
    candidates: z.array(argValue).min(2).max(6),
    frame: FrameSizeSchema.default(DEFAULT_SCALE_FRAME),
    ladder,
  })
  .strict()
  .refine((s) => new Set(s.candidates.map(String)).size === s.candidates.length, {
    message: 'scale candidates repeat a value',
  })

/**
 * A recorded image or clip that is a true-size `frame` (1920x1080 by default). Load checks the
 * file is that size; the page outlines the frame, offers Fit and 1:1, and draws the `ladder` in
 * the frame's top-right corner, each bar as tall as its rung at the scale shown.
 */
export const FrameReferenceSchema = z
  .object({ frame: FrameSizeSchema.default(DEFAULT_SCALE_FRAME), ladder })
  .strict()

export type Motion = z.output<typeof MotionSchema>
export type ArgMotion = z.output<typeof ArgMotionSchema>
export type ClipMotion = z.output<typeof ClipMotionSchema>
export type Keyframe = z.output<typeof KeyframeSchema>
export type MotionMechanism = (typeof MOTION_MECHANISMS)[number]
export type ScaleReference = z.output<typeof ScaleReferenceSchema>
export type LadderRung = z.output<typeof LadderRungSchema>
export type FrameReference = z.output<typeof FrameReferenceSchema>
export type FrameSize = z.output<typeof FrameSizeSchema>

interface MediaFields {
  storyId?: string
  clip?: string
  audio?: string
  transcript?: string
  durationMs?: number
  args?: Record<string, unknown>
  motion?: Motion
  scale?: ScaleReference
  frameReference?: FrameReference
}

/** What a frame's motion and scale ask of its source, as `[field, message]` pairs. */
export function mediaProblems(v: MediaFields): [string, string][] {
  const story = v.storyId !== undefined
  const problems: [string, string][] = []
  if (v.motion?.mechanism === 'arg' && !story)
    problems.push(['motion', 'an arg motion drives a live story; give the variant a storyId'])
  if (v.motion?.mechanism === 'clip' && v.clip === undefined)
    problems.push(['motion', 'a clip motion plays the variant clip; give the variant a clip'])
  if (v.clip !== undefined && v.motion?.mechanism !== 'clip')
    problems.push(['motion', 'a clip variant declares motion { mechanism: "clip" }'])
  if (v.scale && !story)
    problems.push(['scale', 'a scale reference renders a live story; give the variant a storyId'])
  if (v.frameReference && story)
    problems.push([
      'frameReference',
      'a frame reference sizes an image or clip; a story uses scale',
    ])
  problems.push(...audioProblems(v))
  const driven = [
    ...(v.motion?.mechanism === 'arg' ? [v.motion.arg] : []),
    ...(v.scale ? [v.scale.arg] : []),
  ]
  if (driven.length === 2 && driven[0] === driven[1])
    problems.push(['scale', `motion and scale both drive ${driven[0]}; they set different args`])
  for (const arg of new Set(driven))
    if (v.args && Object.hasOwn(v.args, arg))
      problems.push(['args', `${arg} is driven by the frame's motion or scale; drop it from args`])
  return problems
}

/** An audio frame says what it reads and nothing else moves or sizes it; only audio has those fields. */
function audioProblems(v: MediaFields): [string, string][] {
  if (v.audio === undefined)
    return (['transcript', 'durationMs'] as const)
      .filter((field) => v[field] !== undefined)
      .map((field) => [field, `${field} belongs to an audio variant; give the variant audio`])
  return [
    ...(v.transcript === undefined
      ? [
          ['transcript', 'an audio variant shows what it says: give it a transcript'] as [
            string,
            string,
          ],
        ]
      : []),
    ...(['motion', 'frameReference'] as const)
      .filter((field) => v[field] !== undefined)
      .map((field): [string, string] => [field, `an audio variant takes no ${field}`]),
  ]
}

/** Why a recorded frame is not the size its frame reference declares, or null when it is. */
export function frameSizeMismatch(actual: FrameSize, declared: FrameSize): string | null {
  if (actual.width === declared.width && actual.height === declared.height) return null
  return `is ${actual.width}×${actual.height}; its frame reference declares ${declared.width}×${declared.height}`
}

/** A one-line account of a frame's motion, so two CHOICE frames are compared on it too. */
export function motionSetting(motion: Motion | undefined): string {
  if (!motion) return 'static'
  if (motion.mechanism === 'clip') return 'clip'
  return `${motion.arg} ${motion.from}..${motion.to} over ${motion.durationMs}ms`
}
