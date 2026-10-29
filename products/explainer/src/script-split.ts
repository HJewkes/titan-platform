import { cuelessKind, longestCueGapS, scriptPacing, voicedBudget } from "./lint-cadence.js";
import { BEAT_SECONDS } from "./lint-flow.js";
import { beatCues, type ScriptBeat, type ScriptV1 } from "./script-schema.js";

/**
 * A $0 split of a cue-less claim-card whose one stretch runs past `pacing.pictureChangeFailS`: its spoken words, cut on
 * sentence boundaries into consecutive claim-cards that each fit the stretch and keep the beat floor. It is never an
 * answer on its own: the pieces still copy one claim and chip, and their new boundaries carry no spoken link, so the
 * stage hands the split to the repair as its starting script and keeps the result only when it beats the seed.
 */

const SPLIT_KIND = "claim-card";
const [BEAT_FLOOR_S] = BEAT_SECONDS;

/** One beat the split cut: its id, kept by the first piece so every reference stays valid, and each piece's id. */
export interface Split {
  id: string;
  pieces: string[];
}

export interface SplitScript {
  script: ScriptV1;
  splits: Split[];
}

const sentencesOf = (spoken: string): string[] => spoken.trim().split(/(?<=[.!?])\s+/);

const pieceId = (id: string, k: number): string => (k === 0 ? id : `${id}${String.fromCharCode(97 + k)}`);

interface Piece {
  spoken: string;
  words: number;
}

/** Sentences packed in order into the fewest pieces of at most `cap` voiced words, or undefined when one sentence is over. */
function packed(beat: ScriptBeat, cap: number): Piece[] | undefined {
  const words = (spoken: string) => voicedBudget({ ...beat, spoken })?.words ?? Infinity;
  const pieces: Piece[] = [];
  for (const sentence of sentencesOf(beat.spoken)) {
    const last = pieces.at(-1);
    const joined = last && `${last.spoken} ${sentence}`;
    if (joined !== undefined && words(joined) <= cap) pieces[pieces.length - 1] = { spoken: joined, words: words(joined) };
    else pieces.push({ spoken: sentence, words: words(sentence) });
  }
  return pieces.length > 1 && pieces.every((piece) => piece.words <= cap) ? pieces : undefined;
}

/** Each piece's seconds: what its words need, at least the beat floor, then the rest one at a time to the fullest piece. */
function seconds(pieces: readonly Piece[], wordsPerS: number, totalS: number): number[] | undefined {
  const planned = pieces.map((piece) => Math.max(BEAT_FLOOR_S, Math.ceil(piece.words / wordsPerS - 1e-9)));
  const spare = totalS - planned.reduce((sum, s) => sum + s, 0);
  if (spare < 0) return undefined;
  for (let left = spare; left > 0; left = Math.max(0, left - 1)) {
    const fullest = planned.reduce((best, s, k) => (pieces[k]!.words / s > pieces[best]!.words / planned[best]! ? k : best), 0);
    planned[fullest]! += Math.min(1, left);
  }
  return planned;
}

/** The beat as its pieces: the first keeps its id and connector_in, the last keeps heldS, and each keeps the rest. */
function pieces(beat: ScriptBeat, failS: number): ScriptBeat[] | undefined {
  const budget = voicedBudget(beat);
  if (!budget) return undefined;
  const cut = packed(beat, Math.floor(failS * budget.wordsPerS + 1e-9));
  const planned = cut && seconds(cut, budget.wordsPerS, beat.plannedS);
  if (!cut || !planned) return undefined;
  const { heldS, connector_in, ...rest } = beat;
  const last = cut.length - 1;
  const made = cut.map((piece, k) => ({
    ...rest,
    id: pieceId(beat.id, k),
    spoken: piece.spoken,
    plannedS: planned[k]!,
    ...(k === 0 && connector_in !== undefined ? { connector_in } : {}),
    ...(k === last && heldS !== undefined ? { heldS } : {}),
  }));
  return made.every((piece) => (longestCueGapS(piece) ?? Infinity) <= failS) ? made : undefined;
}

const splittable = (beat: ScriptBeat, failS: number): boolean =>
  cuelessKind(beat) === SPLIT_KIND && beatCues(beat.visual).length === 0 && (longestCueGapS(beat) ?? 0) > failS;

/** Every cue-less claim-card past the stretch limit, split where its sentences allow; the script as it came otherwise. */
export function splitCuelessBeats(script: ScriptV1): SplitScript {
  const failS = scriptPacing(script)?.pictureChangeFailS;
  if (failS === undefined) return { script, splits: [] };
  const taken = new Set(script.beats.map((beat) => beat.id));
  const splits: Split[] = [];
  const beats = script.beats.flatMap((beat) => {
    const made = splittable(beat, failS) ? pieces(beat, failS) : undefined;
    if (!made || made.slice(1).some((piece) => taken.has(piece.id))) return [beat];
    splits.push({ id: beat.id, pieces: made.map((piece) => piece.id) });
    return made;
  });
  return { script: splits.length > 0 ? { ...script, beats } : script, splits };
}

/** The repair's job on one split: what code did, and what the pieces still need from the model. */
export const splitHint = ({ id, pieces: ids }: Split): string =>
  `${id} was split by code into ${ids.join(", ")}: give each boundary a spoken link and give each piece a claim and chip from its own words or facts`;
