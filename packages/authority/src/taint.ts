import { z } from "zod";
import { TAINT_KINDS } from "./vocabulary.js";

/** Long enough for a tool name, a host, an item id or an agent id; short enough that fetched content never fits. */
export const TAINT_REF_MAX_LENGTH = 200;

/** One reason an agent identity is tainted. `ref` is a short safe label, never fetched content. */
export const taintSourceSchema = z.strictObject({
  kind: z.enum(TAINT_KINDS),
  ref: z.string().min(1).max(TAINT_REF_MAX_LENGTH),
  at: z.iso.datetime({ offset: true }),
});

export type TaintSource = z.infer<typeof taintSourceSchema>;
