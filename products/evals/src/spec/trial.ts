import { z } from "zod";
import { nonempty, objectFor, sha256, timestamp } from "./common.js";
import type { SpecParseMode } from "./common.js";

export const TRIAL_SCHEMA_VERSION = "titan.trial/v1";

/** Step path (`delegate`, or `delegate/inner` for a champion's own champion step) to the variant hash it resolved to. */
export const resolvedChampions = z.record(nonempty, sha256);

/** One trial's identity, fixed when it starts; `variant` is always a content hash, never the name "champion". */
export function trialSchema(mode: SpecParseMode) {
  return objectFor(mode)({
    schema: z.literal(TRIAL_SCHEMA_VERSION),
    unit: sha256,
    variant: sha256,
    case: sha256,
    startedAt: timestamp,
    champions: resolvedChampions.optional(),
  });
}
