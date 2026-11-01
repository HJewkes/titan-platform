import { numberSpans, spokenText } from "./lint-register.js";
import type { RegisterMetric } from "./lint-register.js";
import type { WritingBeat } from "./writing-check.js";

/** Edits per 1k spoken words; the calibration records the dose at which each row flags 80 % of seeded human windows. */
export const SEEDED_DOSES = [1, 2, 4] as const;
export type SeededDose = (typeof SEEDED_DOSES)[number];

const FLAT_SENTENCE_WORDS = 12;
const SENTENCE_END = /[.!?]+$/;

type Transform = (beats: readonly WritingBeat[], count: number) => WritingBeat[];

/** Sentences cycled through when an edit adds more than one, so no two insertions are identical. */
const ADDED: Readonly<Record<string, readonly string[]>> = {
  triad: ["We tune the queue, the ledger and the log.", "Each van carries boxes, crates or sacks.", "The desk handles scans, labels and returns."],
  "colon-reveal": ["The fix was plain: one short rule.", "The cause was small: a blank field.", "The answer was dull: a longer timeout."],
  "not-x-tail": ["It reads the log, not the queue.", "It trusts the ledger, never the handheld.", "It waits for the clerk, not the driver."],
  "voice-phrase": ["The catch is a blank field.", "That matters on a busy day.", "The server quietly logs it."],
  "verbless-no": ["No retries.", "No manual step.", "No spare scanner."],
  downtoner: ["The server only reads the log.", "The clerk barely needs the shelf.", "The route is nearly fixed."],
  closer: ["That is the desk.", "That is all there is.", "The rest is routine."],
};

const wordCount = (beats: readonly WritingBeat[]): number => spokenText(beats.map((beat) => beat.spoken)).words.length;

/** How many edits a dose means for this script: at least one, so a short script is still edited. */
const editsFor = (beats: readonly WritingBeat[], dose: SeededDose): number => Math.max(1, Math.round((dose * wordCount(beats)) / 1000));

/** Appends each sentence to a beat, spreading the beats evenly through the script. */
function appendSpread(sentences: readonly string[]): Transform {
  return (beats, count) => {
    const targets = Array.from({ length: count }, (_, k) => Math.floor(((k + 0.5) * beats.length) / count));
    return beats.map((beat, i) => {
      const added = targets.flatMap((target, k) => (target === i ? [sentences[k % sentences.length]!] : []));
      return added.length === 0 ? { ...beat } : { ...beat, spoken: [beat.spoken, ...added].join(" ") };
    });
  };
}

/** Swaps the first `count` number mentions in the script for "some". */
const vagueQuantifier: Transform = (beats, count) => {
  let left = count;
  return beats.map((beat) => {
    const hits = numberSpans(spokenText([beat.spoken]).text).slice(0, left);
    left -= hits.length;
    return { ...beat, spoken: hits.reduce((text, hit) => text.replace(hit.text, "some"), beat.spoken) };
  });
};

/** Re-cuts each beat into sentences of one length, so the length spread collapses. */
function flattenBeat(beat: WritingBeat): WritingBeat {
  const words = beat.spoken.split(/\s+/).filter(Boolean).map((word) => word.replace(SENTENCE_END, ""));
  const runs: string[][] = [];
  for (let at = 0; at < words.length; at += FLAT_SENTENCE_WORDS) runs.push(words.slice(at, at + FLAT_SENTENCE_WORDS));
  const tail = runs.length > 1 && runs.at(-1)!.length < FLAT_SENTENCE_WORDS / 2 ? runs.pop()! : [];
  runs.at(-1)?.push(...tail);
  return { ...beat, spoken: runs.map((run) => `${run.join(" ")}.`).join(" ") };
}

const EXPANSIONS: readonly (readonly [RegExp, string])[] = [
  [/\bdon['’]t\b/gi, "do not"], [/\bdoesn['’]t\b/gi, "does not"], [/\bisn['’]t\b/gi, "is not"],
  [/\bhere['’]s\b/gi, "here is"], [/\bthat['’]s\b/gi, "that is"], [/\bit['’]s\b/gi, "it is"], [/\bwhat['’]s\b/gi, "what is"],
  [/\bthere['’]s\b/gi, "there is"], [/\blet['’]s\b/gi, "let us"], [/\byou['’]ll\b/gi, "you will"], [/\bwe['’]ve\b/gi, "we have"],
];

const matchCase = (from: string, to: string): string => (/^[A-Z]/.test(from) ? to.charAt(0).toUpperCase() + to.slice(1) : to);

const expandContractions: Transform = (beats) =>
  beats.map((beat) => ({ ...beat, spoken: EXPANSIONS.reduce((text, [pattern, expansion]) => text.replace(pattern, (hit) => matchCase(hit, expansion)), beat.spoken) }));

const SEEDED_EDITS = {
  triad: appendSpread(ADDED.triad!),
  "colon-reveal": appendSpread(ADDED["colon-reveal"]!),
  "not-x-tail": appendSpread(ADDED["not-x-tail"]!),
  "voice-phrase": appendSpread(ADDED["voice-phrase"]!),
  "verbless-no": appendSpread(ADDED["verbless-no"]!),
  downtoner: appendSpread(ADDED.downtoner!),
  "vague-quantifier": vagueQuantifier,
  closer: appendSpread(ADDED.closer!),
  flatten: (beats) => beats.map(flattenBeat),
  "expand-contractions": expandContractions,
} as const satisfies Record<string, Transform>;

export type SeededEdit = keyof typeof SEEDED_EDITS;

/** Every edit, in the order the golden lists them. */
export const SEEDED_EDIT_NAMES: readonly SeededEdit[] = ["triad", "colon-reveal", "not-x-tail", "voice-phrase", "verbless-no", "downtoner", "vague-quantifier", "closer", "flatten", "expand-contractions"];

/** The register row each edit is meant to move. */
export const SEEDED_ROW: Readonly<Record<SeededEdit, RegisterMetric>> = {
  triad: "triads",
  "colon-reveal": "colon-reveals",
  "not-x-tail": "not-x-tails",
  "voice-phrase": "phrases",
  "verbless-no": "neg-synthetic",
  downtoner: "downtoners",
  "vague-quantifier": "numbers",
  closer: "sentence-mean",
  flatten: "sentence-cv",
  "expand-contractions": "contractions",
};

/** Returns the beats with the edit applied at `dose` edits per 1k words; `flatten` and `expand-contractions` change the whole script whatever the dose. */
export function applySeededEdit(beats: readonly WritingBeat[], edit: SeededEdit, dose: SeededDose): WritingBeat[] {
  return SEEDED_EDITS[edit](beats, editsFor(beats, dose));
}
