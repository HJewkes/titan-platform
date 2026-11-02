import { z } from "zod";

const WaitingGateSchema = z.object({
  gateId: z.string(),
  /** The gate's step without its repeat suffix, such as `approve-merge`. */
  stepId: z.string(),
  repo: z.string(),
  pr: z.number().int().nullable(),
  head: z.string().nullable(),
  task: z.string(),
  since: z.string(),
  ageHours: z.number(),
  /** Whether the head the gate names is the run's current head; null when the gate names none. */
  headIsCurrent: z.boolean().nullable(),
  /** Why the run is held, if it is. */
  held: z.string().nullable(),
});
export type WaitingGate = z.infer<typeof WaitingGateSchema>;

export const WaitingSchema = z.object({ owner: z.array(WaitingGateSchema), seat: z.array(WaitingGateSchema) });
export type Waiting = z.infer<typeof WaitingSchema>;
