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

export const roundNotes = z.object({
  general: z.string(),
  /** Each answered question's comment, by question id. */
  comments: z.record(z.string(), z.string()),
  /** Each sent answer, by question id. */
  answers: z.record(z.string(), sentAnswer),
  /** The earlier rounds a Ship ticked Addressed, from `addressed.json`; empty when none were. */
  addressed: z.array(z.number()),
});

export type RoundNotes = z.infer<typeof roundNotes>;
export type SentAnswer = z.infer<typeof sentAnswer>;

const sentAnswerOf = ({ pick, picks, value, text, revisionRequested, optionNotes, recommendationSeen }: Feedback["answers"][number]): SentAnswer => ({
  ...(pick !== undefined && { pick }),
  ...(picks !== undefined && { picks }),
  ...(value !== undefined && { value }),
  ...(text !== undefined && { text }),
  ...(revisionRequested && { revisionRequested }),
  ...(optionNotes !== undefined && { optionNotes }),
  ...(recommendationSeen && { recommendationSeen }),
});

export function notesOf(feedback: Feedback, addressed: number[]): RoundNotes {
  const commented = feedback.answers.flatMap((answer) => (answer.comment?.trim() ? [[answer.questionId, answer.comment] as const] : []));
  const answers = feedback.answers.map((answer) => [answer.questionId, sentAnswerOf(answer)] as const);
  return { general: feedback.general, comments: Object.fromEntries(commented), answers: Object.fromEntries(answers), addressed };
}

const AddressedSchema = z.object({ schema: z.literal(ADDRESSED_SCHEMA_ID), rounds: z.array(z.number().int()) });

/** The rounds an `addressed.json` ticked; none for one that does not parse. */
export function addressedOf(json: unknown): number[] {
  const parsed = AddressedSchema.safeParse(json);
  return parsed.success ? parsed.data.rounds : [];
}
