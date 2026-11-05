import { beatCues, type ScriptBeat, type ScriptV1 } from "../script-schema.js";
import { StoryboardSchema, type Storyboard } from "../storyboard.js";
import type { FilledBeat, FilledScript } from "../template-fill/fill.js";

/** What the page draws beside a beat's slots: the fill's reveals, emphases, chips and hints, and the chrome's headline and chapter. */
export interface PageExtras {
  reveals: FilledBeat["reveals"];
  emphases?: FilledBeat["emphases"];
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
    reveals: drawn.reveals, emphases: drawn.emphases, chips: drawn.chips, hints: pageHints(drawn.hints, ids), headline: beat.visual.assertion,
    chapter: { n: index + 1, of: script.chapters.length, label: script.chapters[index]!.label },
  };
}

/**
 * The storyboard render draws: each beat the template fill drew, in script order, under its storyboard id, with the
 * spec type and slots the fill chose and the script's own cue words, plus the page extras of each. A custom beat
 * (`customSpecs`, script id to spec type) holds its place with no slots or extras: its built layer draws it.
 */
export function boardFromFill(script: ScriptV1, filled: FilledScript, ids: ReadonlyMap<string, string>, customSpecs: ReadonlyMap<string, string> = new Map()): FillBoard {
  const drawnById = new Map(filled.beats.map((drawn) => [drawn.id, drawn]));
  const extras = new Map<string, PageExtras>();
  const beats = script.beats.filter((beat) => drawnById.has(beat.id) || customSpecs.has(beat.id)).map((beat) => {
    const id = ids.get(beat.id)!;
    const cues = beatCues(beat.visual);
    const drawn = drawnById.get(beat.id);
    if (drawn !== undefined) extras.set(id, pageExtras(script, beat, drawn, ids));
    return {
      id, type: drawn?.spec ?? customSpecs.get(beat.id)!, duration_s: beat.plannedS, spoken: beat.spoken, slots: drawn?.slots ?? {},
      ...(cues.length > 0 ? { cues } : {}),
    };
  });
  return { board: StoryboardSchema.parse({ video_type: script.profile, title: script.id, beats }), extras };
}
