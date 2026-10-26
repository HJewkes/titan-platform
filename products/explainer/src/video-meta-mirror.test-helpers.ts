import { z } from "zod";

/**
 * A copy of the theater's sidecar schema, `apps/console/server/video-meta.ts` (`sidecar`, with the `explainer` block
 * from tp#2380). A product never imports another app's source, so the copy lives here; keep the two in step.
 */
const label = z.string().trim().min(1).max(200);
const MAX_FINGERPRINT_BYTES = 32 * 1024;

const explainerBlock = z.strictObject({
  videoId: label,
  runIds: z.array(label).max(50),
  profile: label,
  scriptSha: label,
  fingerprint: z.json().refine((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_FINGERPRINT_BYTES),
});

export const ConsoleSidecarSchema = z.strictObject({
  schema: z.literal("titan-console/video-meta@1"),
  description: z.string().trim().min(1).max(2000).optional(),
  purpose: z.enum(["daily", "repo-review", "plan", "design", "explainer", "test", "clip"]).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  subject: z.strictObject({ kind: z.enum(["repo", "day", "initiative"]), id: label }).optional(),
  parent: label.optional(),
  posterAtS: z.number().min(0).optional(),
  series: label.optional(),
  take: label.optional(),
  status: z.enum(["draft", "review", "final", "superseded"]).optional(),
  owner: z.string().optional(),
  explainer: explainerBlock.optional(),
  title: label.optional(),
  alias: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).optional(),
  poster: z.string().regex(/^[^/\\\0]{1,200}\.(?:jpe?g|png)$/i).optional(),
});
