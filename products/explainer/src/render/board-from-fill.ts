import { beatCues, type ScriptBeat, type ScriptV1 } from "../script-schema.js";
import { StoryboardSchema, type Storyboard } from "../storyboard.js";
import type { FilledBeat, FilledScript } from "../template-fill/fill.js";

/** What the page draws beside a beat's slots: the fill's reveals, chips and hints, and the chrome's headline and chapter. */
export interface PageExtras {
  reveals: FilledBeat["reveals"];
  chips: FilledBeat["chips"];
  hints: FilledBeat["hints"];
  headline: string;
  chapter: { n: number; of: number; label: string };
}

interface FillBoard {
  board: Storyboard;
  /** By storyboard id, in fill order; a side input to compileTimeline, so the storyboard schema stays as it is. */
  extras: Map<string, PageExtras>;
}

/** The fill names the beat a continuation follows by script id; the page and timeline know only storyboard ids. */
function pageHints(hints: FilledBeat["hints"], ids: ReadonlyMap<string, string>): FilledBeat["hints"] {
  const { continues } = hints;
  return continues === undefined ? hints : { ...hints, continues: ids.get(continues) ?? continues };
}

function pageExtras(script: ScriptV1, beat: ScriptBeat, drawn: FilledBeat, ids: ReadonlyMap<string, string>): PageExtras {
  const index = script.chapters.findIndex((chapter) => chapter.id === beat.chapter);
  return {
    reveals: drawn.reveals, chips: drawn.chips, hints: pageHints(drawn.hints, ids), headline: beat.visual.assertion,
    chapter: { n: index + 1, of: script.chapters.length, label: script.chapters[index]!.label },
  };
}

/**
 * The storyboard render draws: each beat the template fill drew, in script order, under its storyboard id, with the
 * spec type and slots the fill chose and the script's own cue words, plus the page extras of each.
 */
export function boardFromFill(script: ScriptV1, filled: FilledScript, ids: ReadonlyMap<string, string>): FillBoard {
  const byId = new Map(script.beats.map((beat) => [beat.id, beat]));
  const extras = new Map<string, PageExtras>();
  const beats = filled.beats.map((drawn) => {
    const beat = byId.get(drawn.id)!;
    const id = ids.get(drawn.id)!;
    const cues = beatCues(beat.visual);
    extras.set(id, pageExtras(script, beat, drawn, ids));
    return {
      id, type: drawn.spec, duration_s: beat.plannedS, spoken: beat.spoken, slots: drawn.slots,
      ...(cues.length > 0 ? { cues } : {}),
    };
  });
  return { board: StoryboardSchema.parse({ video_type: script.profile, title: script.id, beats }), extras };
}
