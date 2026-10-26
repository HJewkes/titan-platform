import { beatCues, type ScriptV1 } from "../script-schema.js";
import { StoryboardSchema, type Storyboard } from "../storyboard.js";
import type { FilledScript } from "../template-fill/fill.js";

/**
 * The storyboard render draws: each beat the template fill drew, in script order, under its storyboard id, with the
 * spec type and slots the fill chose and the script's own cue words.
 */
export function boardFromFill(script: ScriptV1, filled: FilledScript, ids: ReadonlyMap<string, string>): Storyboard {
  const byId = new Map(script.beats.map((beat) => [beat.id, beat]));
  const beats = filled.beats.map((drawn) => {
    const beat = byId.get(drawn.id)!;
    const cues = beatCues(beat.visual);
    return {
      id: ids.get(drawn.id)!, type: drawn.spec, duration_s: beat.plannedS, spoken: beat.spoken, slots: drawn.slots,
      ...(cues.length > 0 ? { cues } : {}),
    };
  });
  return StoryboardSchema.parse({ video_type: script.profile, title: script.id, beats });
}
