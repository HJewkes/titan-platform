/**
 * An open Ship round's earlier feedback on its unit (TP-3741), for `rounds.get` and `rounds.submit`. The
 * rounds are read through the reader passed in, so `rounds.ts` can call this without an import cycle.
 */
import { z } from "zod";
import type { Feedback, Manifest } from "./round-schema.js";
import { priorFeedback, type PriorFeedback } from "./ship-blockers.js";

export const priorFeedbackList = z.array(
  z.object({
    round: z.number(),
    submittedAt: z.string(),
    pick: z.string().optional(),
    revisionRequested: z.literal(true).optional(),
    comment: z.string().optional(),
    general: z.string().optional(),
  }),
);

type ReadRounds = () => Promise<{ rounds: { manifest: Manifest; feedback: Feedback | null; followUps?: readonly string[] }[] }>;

/** Only a Ship round asks for its earlier feedback to be addressed. */
export async function readPriorFeedback(manifest: Manifest, readRounds: ReadRounds): Promise<PriorFeedback[]> {
  const ship = manifest.questions.some((question) => question.kind === "pick-one" && question.merge !== undefined);
  return ship ? priorFeedback(manifest, (await readRounds()).rounds) : [];
}
