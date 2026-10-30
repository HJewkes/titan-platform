import { SMALL_MOVE_S } from "./composition/beats/stage/video.js";
import { drawnBeats } from "./drawn-beats.js";
import type { L0Check } from "./eval-l0.js";
import { heldBeats, plannedCues, scriptPacing, stretches } from "./lint-cadence.js";
import { countRow } from "./lint-text.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import { DEFAULT_PADDING } from "./workflow/tts-truing.js";

/**
 * Script-time preflight for qa's static-window (TP-4538). Q-D17 holds cue gaps to picture-change's 8 s, but the
 * picture stands still between reveals, and static-window fails any still run past `pacing.staticMaxS`. Only a cue
 * the drawn kind reveals an element on moves the picture: a template beat's reveals, as resolve's fill draws them.
 */

/** One planned stretch with nothing revealed, on the beat's voiced clock from the cut. */
export interface StillStretch {
  fromS: number;
  toS: number;
  /** The cue word that opens it; none for the stretch from the cut. */
  after?: string;
}

export interface StillBeat {
  beat: ScriptBeat;
  stretches: StillStretch[];
}

/** The cue words the drawn beat reveals an element on; undefined when the fill does not draw it at script time (a custom layer). */
function revealWords(script: ScriptV1): (id: string) => ReadonlySet<string> | undefined {
  const drawn = new Map(drawnBeats(script).map(({ filled }) => [filled.id, new Set(filled.reveals.map((reveal) => reveal.atCue))]));
  return (id) => drawn.get(id);
}

// A reveal moves for SMALL_MOVE_S, so the picture stands still only between the end of one move and the next cue.
function stillOver(beat: ScriptBeat, reveals: ReadonlySet<string> | undefined, limitS: number): StillStretch[] {
  const planned = plannedCues(beat);
  if (!planned) return [];
  const { leadS, tailS } = DEFAULT_PADDING;
  const cues = planned.cues.filter(({ cue }) => reveals === undefined || reveals.has(cue)).map(({ cue, s }) => ({ cue, s: leadS + s }));
  const opener = new Map(cues.map(({ cue, s }) => [s, cue]));
  return stretches(cues.map(({ s }) => s), leadS + planned.endS + tailS)
    .filter(([from, to]) => to - from > limitS + SMALL_MOVE_S)
    .map(([fromS, toS]) => ({ fromS, toS, ...(opener.has(fromS) ? { after: opener.get(fromS)! } : {}) }));
}

/** Beats with a planned still stretch past the profile's staticMaxS; a held beat is where static-window allows one. */
export function stillBeats(script: ScriptV1, limitS: number): StillBeat[] {
  const held = new Set(heldBeats(script.beats));
  const reveals = revealWords(script);
  return script.beats.filter((beat) => !held.has(beat.id)).flatMap((beat) => {
    const found = stillOver(beat, reveals(beat.id), limitS);
    return found.length > 0 ? [{ beat, stretches: found }] : [];
  });
}

/** Q-D22: no planned stretch of a beat between revealing cues runs past the profile's `pacing.staticMaxS`. */
export const stillStretchCheck: L0Check = ({ script }) => {
  const pacing = scriptPacing(script);
  if (!pacing) return [];
  return [countRow("Q-D22", stillBeats(script, pacing.staticMaxS).map(({ beat }) => beat.id))];
};
