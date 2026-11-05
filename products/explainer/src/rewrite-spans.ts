import { numberSpans, type TextSpan } from "./lint-register.js";
import { beatCues, type ScriptBeat } from "./script-schema.js";

type CueVisual = Pick<ScriptBeat["visual"], "map_state" | "cues">;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const holdsWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** The beat's cue words, without the `#n` occurrence suffix, that a span of its spoken line holds, each once. */
export function cuedWordsIn(span: string, visual: CueVisual): string[] {
  const words = new Set(beatCues(visual).map((cue) => cue.split("#")[0]!));
  return [...words].filter((word) => holdsWord(span, word));
}

/**
 * A list of three can collapse to one spoken item only when at most one of its words is a cue: the guard refuses a
 * line that stops speaking a cue, so directing the collapse of a cued list only buys a refusal (TP-3881).
 */
export const collapsible = (triad: string, visual: CueVisual): boolean => cuedWordsIn(triad, visual).length <= 1;

// "thirty to thirty-five" and "30–35" say one claim with two numbers; "between thirty and thirty-five" is already one span.
const RANGE_JOIN = /^\s*(?:to|through|–|—|-)\s*$/i;

interface NumberRange {
  low: TextSpan;
  high: TextSpan;
}

/** The ranges a line speaks: two number mentions joined by "to", "through" or a dash, each mention in one range at most. */
export function numberRanges(text: string): NumberRange[] {
  const spans = numberSpans(text);
  const ranges: NumberRange[] = [];
  spans.slice(1).forEach((high, i) => {
    const low = spans[i]!;
    const free = ranges.at(-1)?.high !== low;
    if (free && RANGE_JOIN.test(text.slice(low.index + low.text.length, high.index))) ranges.push({ low, high });
  });
  return ranges;
}

/** The number mentions of a line in order, each range as one mention, so a directive names a range as one number. */
export function numberUnits(text: string): string[] {
  const lows = new Map(numberRanges(text).map((range) => [range.low.index, range.high]));
  const highs = new Set([...lows.values()].map((high) => high.index));
  return numberSpans(text)
    .filter((span) => !highs.has(span.index))
    .map((span) => {
      const high = lows.get(span.index);
      return high ? text.slice(span.index, high.index + high.text.length) : span.text;
    });
}
