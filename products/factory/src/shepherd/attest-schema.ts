import { z } from "zod";

export const MEETER_SHAPES = ["correctness", "adversary"] as const;

/** The attestation rows a run's merge evidence recorded as met, with when the evidence was written. Kept apart from the reader so the watch-row schema imports no step code. */
export const AttestedSchema = z.array(
  z.object({ step: z.string(), closure: z.string(), meeters: z.array(z.object({ name: z.string(), shape: z.enum(MEETER_SHAPES) })), at: z.string() }),
);
