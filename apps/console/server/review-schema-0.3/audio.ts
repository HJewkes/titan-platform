// Vendored from titan-design packages/review-schema/src/audio.ts @ 4fcb3827a72cacf1f81a356bad32630e1f39f9e6 (tag
// review-schema-v0.3.0), lines 1-46 byte-for-byte below this header, because 0.3.0 is not on npm (TD-805). Lines 47-117,
// the blind-ab play order and key, are left out: nothing here calls them, and they fail noUncheckedIndexedAccess.
// TP-3232 deletes this directory when it installs the release. Never edit: re-vendor from a tag.
import { z } from 'zod'

// Audio on a round (TD-916): a variant can be a sound to listen to, and a blind-ab question plays
// pairs of takes in a seeded order the page never learns, so the owner can compare engines blind.

/** An audio file relative to the round file, under the same path rules as an image or clip. */
export const audioPath = z
  .string()
  .regex(
    /^(?![/\\]|[A-Za-z]:)(?!(.*[/\\])?\.\.([/\\]|$)).+\.(?:[Ww][Aa][Vv]|[Mm][Pp]3|[Oo][Gg][Gg]|[Mm]4[Aa])$/,
    'a .wav, .mp3, .ogg or .m4a path relative to the round file, without .. segments'
  )

/** How long a recording runs, when the round wants it stated; the file is the authority. */
export const audioDuration = z.number().int().min(100).max(600_000)

const extension = (path: string) => path.slice(path.lastIndexOf('.')).toLowerCase()

const pairId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'letters, digits, _ and - only')

/** One engine's take of a pair; `engine` is the hidden key, which the page never receives. */
export const BlindTakeSchema = z
  .object({ engine: z.string().min(1), src: audioPath, durationMs: audioDuration.optional() })
  .strict()

/** One line read by two engines; the page plays them as A and B in the round's seeded order. */
export const BlindPairSchema = z
  .object({
    id: pairId,
    transcript: z.string().min(1),
    takes: z.tuple([BlindTakeSchema, BlindTakeSchema]),
  })
  .strict()
  .refine((p) => p.takes[0].engine !== p.takes[1].engine, {
    message: 'a pair compares two engines: its takes name different engines',
  })
  .refine((p) => extension(p.takes[0].src) === extension(p.takes[1].src), {
    message: 'the takes of a pair share one format, so the file type does not tell them apart',
  })

/** The positions a blind pair is played in; an answer names one of them, never an engine. */
export const BLIND_CHOICES = ['A', 'B'] as const

export type BlindChoice = (typeof BLIND_CHOICES)[number]
export type BlindTake = z.output<typeof BlindTakeSchema>
export type BlindPair = z.output<typeof BlindPairSchema>
