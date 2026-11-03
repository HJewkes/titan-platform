import { motion } from "@titan-design/react-ui/theme/tokens";
import { SMALL_MOVE_S } from "./composition/beats/stage/video-timing.js";
import type { FilledBeat } from "./template-fill/fill.js";

/**
 * How long a drawn kind's picture keeps moving once an element lands (TP-4538): the script-time model of each
 * template's own entrance and count-up, so Q-D22 counts as still only what qa's framediff would see still.
 * The template constants are mirrored here, each cited; `drawn-motion.test.ts` pins them to the template sources.
 * The CLI loads this under plain node, so it reads react-ui's import-free tokens, not its motion entry (TP-4561).
 */

/** TitleBeat.tsx: the claim's words rise one after another. */
export const CLAIM_WORDS_START_S = 0.15;
export const CLAIM_WORD_EACH_S = 0.08;
/** StatBeat.tsx: a figure counts up on a spring from this long after its card lands. */
export const STAT_COUNT_START_S = 0.2;
export const STAT_COUNT_SPRING = { stiffness: 120, damping: 18 } as const;
// A count step under 1 % of the figure is a sub-pixel change of its glyphs, under the framediff's floor.
export const STAT_COUNT_VISIBLE = 1e-2;
/** springSettleS(STAT_COUNT_SPRING, STAT_COUNT_VISIBLE), which lives only in react-ui's motion entry. */
export const STAT_COUNT_SETTLE_S = 0.5741261371460324;
/** OutroBeat.tsx: the action rises this long after the line. */
export const OUTRO_ACTION_S = 0.9;

// react-ui builds MOTION.duration from this token table the same way, milliseconds over 1e3.
const SLOW_S = motion.duration.slow / 1e3;
const NORMAL_S = motion.duration.normal / 1e3;

const words = (text: unknown): number => (typeof text === "string" ? text.split(/\s+/).filter(Boolean).length : 0);

// The entrance `enter` runs on progressAt's default, MOTION's slow duration.
function claimEntranceS(slots: FilledBeat["slots"]): number {
  const cascade = CLAIM_WORDS_START_S + Math.max(0, words(slots["claim"]) - 1) * CLAIM_WORD_EACH_S + SLOW_S;
  const quote = slots["quote"] === undefined ? 0 : CLAIM_WORD_EACH_S + NORMAL_S;
  return cascade + quote;
}

/** Seconds the picture moves after one of the beat's reveals lands. */
export function revealMotionS(filled: Pick<FilledBeat, "spec" | "slots">): number {
  if (filled.spec === "claim-card") return claimEntranceS(filled.slots);
  if (filled.spec === "stat") return Math.max(SLOW_S, STAT_COUNT_START_S + STAT_COUNT_SETTLE_S);
  // A button's action rises after its line; an outro (OutroKindBeat) draws no action.
  if (filled.spec === "button") return OUTRO_ACTION_S + SLOW_S;
  if (filled.spec === "outro") return SLOW_S;
  return SMALL_MOVE_S;
}
