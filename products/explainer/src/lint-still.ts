import { SMALL_MOVE_S } from "./composition/beats/stage/video.js";
import { drawnBeats, isSlots, screenTokens, type DrawnBeat } from "./drawn-beats.js";
import { closingMotionS, revealMotionS } from "./drawn-motion.js";
import { drawnTexts, isHeading, type DrawnText } from "./drawn-texts.js";
import type { L0Check } from "./eval-l0.js";
import { heldBeats, plannedCues, scriptPacing, stretches } from "./lint-cadence.js";
import { countRow } from "./lint-text.js";
import type { TimingProfile } from "./qa/timing-gates.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { DEFAULT_PADDING, trueDuration } from "./workflow/tts-truing.js";

/**
 * Script-time preflight for qa's static-window (TP-4538). Q-D17 holds cue gaps to picture-change's 8 s, but the
 * picture stands still between reveals, and static-window fails any still run past `pacing.staticMaxS`. Only a cue
 * the drawn kind reveals an element on moves the picture: every reveal resolve's fill draws, each on its word.
 * As qa does, the reading hold of each drawn text the voice does not say is not still time, and neither is a kind's
 * own entrance, count-up or fade. A beat ends where truing ends it, the settle after its tail included.
 */

type Pacing = TimingProfile["pacing"];

/** One planned run of still picture, on the beat's voiced clock from the cut. */
export interface StillStretch {
  fromS: number;
  toS: number;
  /** The cue word that opens the stretch between reveals it lies in; none for the stretch from the cut. */
  after?: string;
}

interface StillBeat {
  beat: ScriptBeat;
  stretches: StillStretch[];
}

interface Window {
  fromS: number;
  toS: number;
}

const ITEM_TARGET = /^(.+)-(\d+)$/;

/** The words of the slot element a reveal targets: a `<field>-<n>` item's drawn fields, or a whole slot. */
function targetWords(slots: Record<string, unknown>, target: string): Set<string> {
  const item = ITEM_TARGET.exec(target);
  const field = item && Array.isArray(slots[item[1]!]) ? (slots[item[1]!] as unknown[])[Number(item[2]) - 1] : slots[target];
  const leaves = isSlots(field) ? Object.entries(field).filter(([key]) => key !== "id").map(([, value]) => value) : [field];
  return new Set(leaves.flatMap((leaf) => (typeof leaf === "string" || typeof leaf === "number" ? screenTokens(String(leaf)) : [])));
}

// The chrome and the heading rise at the cut; a stage text shows on the reveal whose element holds its words. A text
// matched to no reveal is given no hold, so the row errs toward qa's fail, not its pass.
function shownAt(shown: DrawnText, words: readonly string[], reveals: readonly { s: number; words: Set<string> }[]): number | undefined {
  if (shown.cls.startsWith("xp-") || isHeading(shown)) return 0;
  return reveals.find((reveal) => words.every((word) => reveal.words.has(word)))?.s;
}

/** qa's reading holds on a drawn beat: each text not wholly spoken holds max(readingMinS, chars / readingCps) from when it shows. */
function readingWindows(drawn: DrawnBeat, beat: ScriptBeat, cueAt: (cue: string) => number, pacing: Pacing): Window[] {
  const spoken = new Set(screenTokens(spellSpokenNumbers(beat).spoken));
  const reveals = drawn.filled.reveals.map((reveal) => ({ s: cueAt(reveal.atCue), words: targetWords(drawn.filled.slots, reveal.target) }));
  return (drawnTexts(drawn) ?? []).flatMap((shown) => {
    const words = screenTokens(shown.text);
    if (words.length === 0 || words.every((word) => spoken.has(word))) return [];
    const fromS = shownAt(shown, words, reveals);
    return fromS === undefined ? [] : [{ fromS, toS: fromS + Math.max(pacing.readingMinS, shown.text.trim().length / pacing.readingCps) }];
  });
}

/** The parts of a stretch no window (a move, a fade, a reading hold) covers. */
function uncovered([from, to]: [number, number], windows: readonly Window[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = from;
  for (const window of [...windows].sort((a, b) => a.fromS - b.fromS)) {
    if (window.toS <= start || window.fromS >= to) continue;
    if (window.fromS > start) runs.push([start, window.fromS]);
    start = Math.max(start, window.toS);
  }
  if (start < to) runs.push([start, to]);
  return runs;
}

interface Moved {
  cue: string;
  s: number;
  /** Seconds the picture moves from `s`. */
  motionS: number;
}

type Clock = NonNullable<ReturnType<typeof plannedCues>>;

/**
 * What moves the picture, on the voiced clock: each reveal the fill draws, on its word (a first-word reveal at the
 * voice's start), moving for its kind's entrance; a custom layer, which the fill does not draw, moves on every cue.
 */
function moves(drawn: DrawnBeat | undefined, clock: Clock): Moved[] {
  const { leadS } = DEFAULT_PADDING;
  if (!drawn) return clock.cues.map(({ cue, s }) => ({ cue, s: leadS + s, motionS: SMALL_MOVE_S }));
  const motionS = revealMotionS(drawn.filled);
  return drawn.filled.reveals.map(({ atCue }) => ({ cue: atCue, s: leadS + Math.min(clock.endS, clock.wordS(atCue) ?? 0), motionS }));
}

/** The beat's still runs past staticMaxS: between moves, to its trued end, outside each move, fade and reading hold. */
function stillOver(beat: ScriptBeat, drawn: DrawnBeat | undefined, pacing: Pacing): StillStretch[] {
  const clock = plannedCues(beat);
  if (!clock) return [];
  const moved = moves(drawn, clock);
  const endS = trueDuration(beat.plannedS, clock.speechS);
  const at = new Map(moved.map(({ cue, s }) => [cue, s]));
  const closingS = drawn ? closingMotionS(drawn.filled) : 0;
  const windows = [
    ...moved.map(({ s, motionS }) => ({ fromS: s, toS: s + motionS })),
    { fromS: endS - closingS, toS: endS },
    ...(drawn ? readingWindows(drawn, beat, (cue) => at.get(cue) ?? DEFAULT_PADDING.leadS, pacing) : []),
  ];
  const opener = new Map(moved.map(({ cue, s }) => [s, cue]));
  return stretches(moved.map(({ s }) => s), endS).flatMap((stretch) => {
    const after = opener.get(stretch[0]);
    return uncovered(stretch, windows)
      .filter(([from, to]) => to - from > pacing.staticMaxS)
      .map(([fromS, toS]) => ({ fromS, toS, ...(after === undefined ? {} : { after }) }));
  });
}

/** Beats with a planned still run past the profile's staticMaxS; a held beat is where static-window allows one. */
export function stillBeats(script: ScriptV1, pacing: Pacing): StillBeat[] {
  const held = new Set(heldBeats(script.beats));
  // A beat the fill does not draw at script time (a custom layer) counts every cue and no reading hold.
  const drawn = new Map(drawnBeats(script).map((beat) => [beat.filled.id, beat]));
  return script.beats.filter((beat) => !held.has(beat.id)).flatMap((beat) => {
    const found = stillOver(beat, drawn.get(beat.id), pacing);
    return found.length > 0 ? [{ beat, stretches: found }] : [];
  });
}

/** Q-D22: no planned still run of a beat, between revealing cues and outside reading holds, passes `pacing.staticMaxS`. */
export const stillStretchCheck: L0Check = ({ script }) => {
  const pacing = scriptPacing(script);
  if (!pacing) return [];
  return [countRow("Q-D22", stillBeats(script, pacing).map(({ beat }) => beat.id))];
};
