import { z } from "zod";

/** The verdict that satisfied a hold: its reviewer's name, the session that wrote it, and where in that session's transcript. */
export const HoldSatisfiedBySchema = z.object({ reviewer: z.string(), agentId: z.string(), sessionId: z.string(), locator: z.looseObject({}) });
export type HoldSatisfiedBy = z.infer<typeof HoldSatisfiedBySchema>;

export interface HoldSatisfaction {
  head: string;
  by: HoldSatisfiedBy;
}
