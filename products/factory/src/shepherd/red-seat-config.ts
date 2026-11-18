import { z } from "zod";
import { isRepoKey } from "./seats.js";

/**
 * `shepherd.redSeat`: where serve's main CI watch sends a red-main event, ahead of the run's seat, the branch-prefix seat
 * and `hubSeat`: the repo's entry (keys match in any case), else `fallback`. Red events only; merge policy and seat
 * identity never read it.
 */
export const RedSeatConfigSchema = z.strictObject({
  repos: z.record(z.string().refine(isRepoKey, "must be an owner/name repo"), z.string().min(1)).optional(),
  fallback: z.string().min(1).optional(),
});
