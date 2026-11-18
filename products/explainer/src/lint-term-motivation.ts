import type { L0Check } from "./eval-l0.js";
import { plainWords, type ScriptBeat } from "./script-schema.js";
import { cappedRow, gateL0Row } from "./writing-gate.js";
import { writingGatePolicy } from "./writing-gate-policy.js";

const normal = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Index of the first spoken word where the term's words run on in order, or -1 when the beat never speaks it. */
function termWordIndex(words: readonly string[], term: string): number {
  const wanted = normal(term).split(" ");
  return words.findIndex((_, at) => wanted.every((word, offset) => words[at + offset] === word));
}

/** Planned seconds from the start of the script to the start of each beat. */
function beatStartsS(beats: readonly ScriptBeat[]): Map<string, number> {
  let elapsed = 0;
  return new Map(beats.map((beat) => {
    const start = elapsed;
    elapsed += beat.plannedS;
    return [beat.id, start];
  }));
}

/** A term's planned seconds from its chapter's start to its first spoken word, or undefined when no beat speaks it. */
function motivationS(beats: readonly ScriptBeat[], starts: ReadonlyMap<string, number>, term: string): number | undefined {
  for (const beat of beats) {
    const words = plainWords(beat.spoken).map(normal);
    const at = termWordIndex(words, term);
    if (at === -1) continue;
    const chapterStart = starts.get(beats.find((other) => other.chapter === beat.chapter)!.id)!;
    return starts.get(beat.id)! + (at / words.length) * beat.plannedS - chapterStart;
  }
  return undefined;
}

/**
 * hallmark:motivated-before-named (TP-6350): the count of declared new_terms first spoken before `minS` planned seconds
 * of their chapter have passed, so the why comes before the name. A term no beat speaks is left to the other term rows.
 */
export const termMotivationCheck: L0Check = ({ script }) => {
  const rule = writingGatePolicy().hallmarks["motivated-before-named"];
  const starts = beatStartsS(script.beats);
  const early = script.beats.flatMap((beat) => beat.new_terms.flatMap((term) => {
    const seconds = motivationS(script.beats, starts, term);
    return seconds !== undefined && seconds < rule.minS ? [beat.id] : [];
  }));
  return [gateL0Row(cappedRow("hallmark:motivated-before-named", early.length, rule, early))];
};
