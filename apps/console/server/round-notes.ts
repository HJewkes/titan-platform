/**
 * A sent round as `rounds.get` reads it back (TP-3767): the free text, every answer and the Addressed ticks, so a
 * reload shows the round locked with what was sent. The strict feedback@1 schema has no field for the ticks, so
 * `rounds-submit.ts` writes them to the `addressed.json` sidecar named here. This module must not import
 * `rounds.ts`, which reads the files and calls it.
 */
import { z } from "zod";
import type { Feedback } from "./round-schema.js";

export const ADDRESSED_FILE = "addressed.json";
export const ADDRESSED_SCHEMA_ID = "titan-console/addressed@1";
export const MAX_ADDRESSED_BYTES = 64 * 1024;

/** One question's sent answer as feedback.json holds it, less its comment, which `comments` carries. */
const sentAnswer = z.object({
  pick: z.string().optional(),
  picks: z.array(z.string()).optional(),
  value: z.number().optional(),
  text: z.string().optional(),
  revisionRequested: z.literal(true).optional(),
  optionNotes: z.array(z.object({ option: z.string(), note: z.string() })).optional(),
  recommendationSeen: z.literal(true).optional(),
});

/** A pin as sent; its number is the suffix of its `${key}-${n}` id. */
const sentPin = z.object({
  id: z.string(),
  xPct: z.number(),
  yPct: z.number(),
  note: z.string(),
  target: z.object({ testId: z.string().optional(), role: z.string().optional(), text: z.string().optional() }).optional(),
});

/** One frame's sent verdict, comment and pins (TP-3773). */
const sentFrame = z.object({
  verdict: z.enum(["chosen", "rejected", "maybe"]).nullable(),
  comment: z.string(),
  annotations: z.array(sentPin),
});

export const roundNotes = z.object({
  general: z.string(),
  /** Each answered question's comment, by question id. */
  comments: z.record(z.string(), z.string()),
  /** Each sent answer, by question id. */
  answers: z.record(z.string(), sentAnswer),
  /** The earlier rounds a Ship ticked Addressed, from `addressed.json`; empty when none were. */
  addressed: z.array(z.number()),
  /** Each frame that was sent a verdict, a comment or a pin, by variant key; absent when none was. */
  frames: z.record(z.string(), sentFrame).optional(),
});

export type RoundNotes = z.infer<typeof roundNotes>;
export type SentAnswer = z.infer<typeof sentAnswer>;
type SentFrame = z.infer<typeof sentFrame>;

const sentAnswerOf = ({ pick, picks, value, text, revisionRequested, optionNotes, recommendationSeen }: Feedback["answers"][number]): SentAnswer => ({
  ...(pick !== undefined && { pick }),
  ...(picks !== undefined && { picks }),
  ...(value !== undefined && { value }),
  ...(text !== undefined && { text }),
  ...(revisionRequested && { revisionRequested }),
  ...(optionNotes !== undefined && { optionNotes }),
  ...(recommendationSeen && { recommendationSeen }),
});

const sentPinOf = ({ id, xPct, yPct, note, target }: Feedback["variants"][number]["annotations"][number]): SentFrame["annotations"][number] => ({
  id,
  xPct,
  yPct,
  note,
  ...(target !== undefined && { target }),
});

/** The frames whose feedback holds something; every other frame is the server's undecided echo. */
function framesOf(variants: Feedback["variants"]): Record<string, SentFrame> {
  const held = variants.filter(({ verdict, comment, annotations }) => verdict !== null || comment.trim() !== "" || annotations.length > 0);
  return Object.fromEntries(held.map(({ key, verdict, comment, annotations }) => [key, { verdict, comment, annotations: annotations.map(sentPinOf) }]));
}

export function notesOf(feedback: Feedback, addressed: number[]): RoundNotes {
  const commented = feedback.answers.flatMap((answer) => (answer.comment?.trim() ? [[answer.questionId, answer.comment] as const] : []));
  const answers = feedback.answers.map((answer) => [answer.questionId, sentAnswerOf(answer)] as const);
  const frames = framesOf(feedback.variants);
  return {
    general: feedback.general,
    comments: Object.fromEntries(commented),
    answers: Object.fromEntries(answers),
    addressed,
    ...(Object.keys(frames).length > 0 && { frames }),
  };
}

const AddressedSchema = z.object({ schema: z.literal(ADDRESSED_SCHEMA_ID), rounds: z.array(z.number().int()) });

/** The rounds an `addressed.json` ticked; none for one that does not parse. */
export function addressedOf(json: unknown): number[] {
  const parsed = AddressedSchema.safeParse(json);
  return parsed.success ? parsed.data.rounds : [];
}
