import type { ScriptBeat } from "../script-schema.js";
import { compareSide, cueWords } from "./label-parse.js";
import type { Derivation, Reveal } from "./types.js";

const COMPARE_ROWS_MAX = 4;
const MYTH_OR_FACT = /^(?:myth|fact):\s*/i;

type Side = NonNullable<ReturnType<typeof compareSide>>;

function compareRefusal(sides: readonly (Side | undefined)[]): string | undefined {
  if (sides.length === 0 || sides.some((side) => side === undefined)) return "compare needs a `before:` or `after:` prefix on every label";
  const lefts = sides.filter((side) => side?.side === "left").length;
  const rights = sides.length - lefts;
  if (lefts === 0 || rights === 0) return "compare needs both `before:` and `after:` labels";
  if (lefts !== rights) return `compare pairs labels by order, and has ${lefts} before and ${rights} after`;
  return lefts > COMPARE_ROWS_MAX ? `compare holds at most ${COMPARE_ROWS_MAX} rows, not ${lefts}` : undefined;
}

/**
 * `before:` labels on the left, `after:` on the right, the k-th of each paired as row k. Each label keeps its own
 * reveal on its own cue word, so a side lands when it is said.
 */
export function deriveCompare(beat: ScriptBeat): Derivation {
  const sides = beat.visual.labels.map(compareSide);
  const refusal = compareRefusal(sides);
  if (refusal !== undefined) return { reason: refusal };
  const words = cueWords(beat, sides.length);
  const seen = { left: 0, right: 0 };
  const rows: { id: string; left: string; right: string }[] = [];
  const reveals: Reveal[] = sides.map((found, i) => {
    const { side, text } = found!;
    const k = (seen[side] += 1);
    if (rows.length < k) rows.push({ id: `rows-${k}`, left: "", right: "" });
    rows[k - 1]![side] = text;
    return { target: `rows-${k}`, part: side, atCue: words[i]! };
  });
  return { slots: { leftTitle: "Before", rightTitle: "After", rows }, reveals };
}

/** The belief is the first label and the reality the second, a `myth:` or `fact:` prefix dropped. */
export function deriveMisconception(beat: ScriptBeat): Derivation {
  const [belief, reality] = beat.visual.labels.map((label) => label.replace(MYTH_OR_FACT, ""));
  if (belief === undefined || reality === undefined) return { reason: "misconception needs a belief label and a reality label" };
  return { slots: { belief, reality }, reveals: [] };
}
