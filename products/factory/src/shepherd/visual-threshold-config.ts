import { z } from "zod";

const MI = 1024 * 1024;

/**
 * One repo's visual-diff threshold (TP-4320). Absent, or `off`, records nothing; `shadow` records the delta on the merge
 * evidence, and nothing decides on it; `on` also decides the merge on it. `maxChangedShare` defaults to 0.01 of the content box and `pixelTolerance` to 0.1.
 * The caps bound the measuring work per evidence step, so each has a ceiling config cannot raise: `maxSnapshots` pairs,
 * `maxBytes` per blob, `maxPixels` per decoded image and `maxTotalPixels` decoded over the step.
 */
export const VisualThresholdSchema = z.strictObject({
  mode: z.enum(["off", "shadow", "on"]),
  maxChangedShare: z.number().min(0).max(1).optional(),
  pixelTolerance: z.number().min(0).max(1).optional(),
  snapshotPaths: z.array(z.string().min(1)),
  apiPaths: z.array(z.string().min(1)),
  tokenPaths: z.array(z.string().min(1)),
  harnessPaths: z.array(z.string().min(1)),
  maxSnapshots: z.number().int().positive().max(200).optional(),
  maxBytes: z.number().int().positive().max(20 * MI).optional(),
  maxPixels: z.number().int().positive().max(32 * MI).optional(),
  maxTotalPixels: z.number().int().positive().max(256 * MI).optional(),
});
