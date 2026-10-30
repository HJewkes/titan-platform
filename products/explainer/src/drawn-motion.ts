import { MOTION, springSettleS } from "@titan-design/react-ui/motion";
import { SMALL_MOVE_S } from "./composition/beats/stage/video.js";
import { OUTRO_FADE_OUT_S } from "./composition/beats/stage/outro-fade.js";
import type { FilledBeat } from "./template-fill/fill.js";

/**
 * How long a drawn kind's picture keeps moving once an element lands (TP-4538): the script-time model of each
 * template's own entrance, count-up and fade, so Q-D22 counts as still only what qa's framediff would see still.
 * The template constants are mirrored here, each cited; `drawn-motion.test.ts` pins them to the template sources.
 */

/** TitleBeat.tsx: the claim's words rise one after another. */
export const CLAIM_WORDS_START_S = 0.15;
export const CLAIM_WORD_EACH_S = 0.08;
/** StatBeat.tsx: a figure counts up on a spring from this long after its card lands. */
export const STAT_COUNT_START_S = 0.2;
export const STAT_COUNT_SPRING = { stiffness: 120, damping: 18 } as const;
/** OutroBeat.tsx: the action rises this long after the line. */
export const OUTRO_ACTION_S = 0.9;

// A count step under 1 % of the figure is a sub-pixel change of its glyphs, under the framediff's floor.
const COUNT_VISIBLE = 1e-2;
const OUTRO_KINDS: ReadonlySet<string> = new Set(["outro", "button"]);

const words = (text: unknown): number => (typeof text === "string" ? text.split(/\s+/).filter(Boolean).length : 0);

// The entrance `enter` runs on progressAt's default, MOTION's slow duration.
function claimEntranceS(slots: FilledBeat["slots"]): number {
  const cascade = CLAIM_WORDS_START_S + Math.max(0, words(slots["claim"]) - 1) * CLAIM_WORD_EACH_S + MOTION.duration.slow;
  const quote = slots["quote"] === undefined ? 0 : CLAIM_WORD_EACH_S + MOTION.duration.normal;
  return cascade + quote;
}

/** Seconds the picture moves after one of the beat's reveals lands. */
export function revealMotionS(filled: Pick<FilledBeat, "spec" | "slots">): number {
  if (filled.spec === "claim-card") return claimEntranceS(filled.slots);
  if (filled.spec === "stat") return Math.max(MOTION.duration.slow, STAT_COUNT_START_S + springSettleS(STAT_COUNT_SPRING, COUNT_VISIBLE));
  // A button's action rises after its line; an outro (OutroKindBeat) draws no action.
  if (filled.spec === "button") return OUTRO_ACTION_S + MOTION.duration.slow;
  if (filled.spec === "outro") return MOTION.duration.slow;
  return SMALL_MOVE_S;
}

/** Seconds before the beat's end its picture moves on its own: an outro or button fades out. */
export const closingMotionS = (filled: Pick<FilledBeat, "spec">): number => (OUTRO_KINDS.has(filled.spec) ? OUTRO_FADE_OUT_S : 0);
