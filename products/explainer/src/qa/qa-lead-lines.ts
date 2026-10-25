import { z } from "zod";
import { fillAtResolve } from "../resolve-stage.js";
import { FillError } from "../template-fill/fill.js";
import type { CheckInput } from "../workflow/stage-checks.js";

/** The spike sample builder's `visual.json`, as far as QA reads it. */
const VisualLeadSchema = z.object({ beats: z.array(z.object({ id: z.string(), qaLeadLine: z.boolean().optional() })) });

type LeadInput = Pick<CheckInput, "artifacts" | "store">;

function fromFill(input: LeadInput): Set<string> {
  const filled = fillAtResolve(input);
  if (filled instanceof FillError) return new Set();
  return new Set(filled.beats.filter((beat) => beat.hints.qaLeadLine).map((beat) => beat.id));
}

/**
 * Beats whose lead line stands alone by design (a verdict card), which late-fill does not read, as the spike's
 * `examples/qa.ts` skips them: a bridged render's `visual` marks them, an in-process run's template fill hints them.
 */
export function leadLineBeats(input: LeadInput): Set<string> {
  const { visual, resolved } = input.artifacts;
  if (visual !== undefined) {
    const { beats } = VisualLeadSchema.parse(JSON.parse(input.store.readText(visual)));
    return new Set(beats.filter((beat) => beat.qaLeadLine).map((beat) => beat.id));
  }
  return resolved === undefined ? new Set() : fromFill(input);
}
