import { z } from "zod";
import { storyboardIds } from "../render/beat-ids.js";
import { fillAtResolve, ResolvedSchema } from "../resolve-stage.js";
import { ScriptSchema } from "../script-schema.js";
import { FillError } from "../template-fill/fill.js";
import type { CheckInput } from "../workflow/stage-checks.js";

/** The spike sample builder's `visual.json`, as far as QA reads it. */
const VisualLeadSchema = z.object({ beats: z.array(z.object({ id: z.string(), qaLeadLine: z.boolean().optional() })) });

type LeadInput = Pick<CheckInput, "artifacts" | "store">;

function fromFill(input: LeadInput): Set<string> {
  const filled = fillAtResolve(input);
  if (filled instanceof FillError) return new Set();
  // The render's timeline names beats by storyboard id, so QA's lead-line set must too.
  const json = (name: string): unknown => JSON.parse(input.store.readText(input.artifacts[name]!));
  const ids = storyboardIds(ScriptSchema.parse(json("script")), ResolvedSchema.parse(json("resolved")));
  return new Set(filled.beats.filter((beat) => beat.hints.qaLeadLine).map((beat) => ids.get(beat.id)!));
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
