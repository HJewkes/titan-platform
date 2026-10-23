import type { L0Check } from "./eval-l0.js";
import { countRow } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// Geometry of the headline band, from the explainer chrome stylesheet: `.xp-band-top` is padded by
// `--xp-edge` on each side of a 1920 px canvas and sized for two lines of `.xp-headline`, whose font size is
// `--beat-body` (48 px) times 1.3, with `overflow: hidden`. A third line is clipped, not shown.
const CANVAS_WIDTH_PX = 1920;
const BAND_EDGE_PX = 60;
const BEAT_BODY_PX = 48;
const HEADLINE_SCALE = 1.3;
export const HEADLINE_MAX_LINES = 2;

// Mean advance of the heading face as a share of its font size, rounded up so the estimate errs towards a wrap.
const AVERAGE_CHAR_EM = 0.52;

export const HEADLINE_CHARS_PER_LINE = Math.floor((CANVAS_WIDTH_PX - 2 * BAND_EDGE_PX) / (BEAT_BODY_PX * HEADLINE_SCALE * AVERAGE_CHAR_EM));

/** Lines a greedy word wrap gives the headline; a word wider than a line takes the lines it needs. */
export function headlineLines(headline: string, charsPerLine = HEADLINE_CHARS_PER_LINE): number {
  let lines = 1;
  let used = 0;
  for (const word of headline.split(/\s+/).filter(Boolean)) {
    const fit = used === 0 ? word.length : used + 1 + word.length;
    if (fit <= charsPerLine) {
      used = fit;
      continue;
    }
    if (used > 0) lines += 1;
    lines += Math.floor((word.length - 1) / charsPerLine);
    used = ((word.length - 1) % charsPerLine) + 1;
  }
  return lines;
}

const headlineOf = (beat: ScriptBeat): string => beat.visual.assertion;

export const overlongHeadlines = (beats: readonly ScriptBeat[]): ScriptBeat[] =>
  beats.filter((beat) => headlineLines(headlineOf(beat)) > HEADLINE_MAX_LINES);

/** Q-V13: a beat headline wraps to at most two lines at the band's width, so the band never clips it. */
export const headlineCheck: L0Check = ({ script }) => [countRow("Q-V13", overlongHeadlines(script.beats).map((beat) => beat.id))];
