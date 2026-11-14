import type { L0Check } from "./eval-l0.js";
import { frameRefrainRow, parallelRecapRow, type HallmarkSentence } from "./lint-hallmarks-frames.js";
import { sentenceLengths, spokenText } from "./lint-register.js";
import { cappedRow, gateL0Row, type GateRow } from "./writing-gate.js";
import { writingGatePolicy, type GateSeverity, type WritingGatePolicy } from "./writing-gate-policy.js";

/** A beat as the hallmark detectors read it; chapter and declared terms are optional, so plain text can be scored too. */
export interface HallmarkBeat {
  id: string;
  spoken: string;
  chapter?: string;
  new_terms?: readonly string[];
}

type Hallmarks = WritingGatePolicy["hallmarks"];

// The naming refrain (TP-5721 #1): a short sentence whose main clause names a thing. An explicit naming verb counts
// from the sentence head; a bare copula counts only when the whole sentence is "That <noun> is the <name>." and its
// complement is a name, not a verdict: on the lab's human corpus "That's a good question." and "That's the plan." are
// most of what a bare copula matches (TP-5721 S1).
const NAMING_VERB = /^(?:(?:and|so|but|now)\s+)?(?:(?:that|this)(?:\s+[\w'’-]+){0,3}?\s+(?:is|are|was)\s+(?:called|known as|named)\b|(?:we|you|they|people)\s+call\s+(?:this|that|it)\b)/i;
const NAMING_COPULA = /^(?:(?:and|so|but|now)\s+)?(?:that(?:\s+[\w'’-]+){0,3}?\s+(?:is|was)|that['’]s)\s+(?:the|an?)\s+([\w'’-]+(?:\s+[\w'’-]+){0,2})[.!?]["”’)]*$/i;
const VERDICT_WORDS = new Set([
  "good", "great", "bad", "true", "real", "whole", "big", "best", "worst", "first", "last", "main", "same", "other", "most", "very", "perfectly",
  "thing", "things", "question", "story", "plan", "point", "idea", "end", "start", "way", "problem", "reason", "part", "one", "case", "key",
  "answer", "trick", "goal", "deal", "difference", "catch", "bit", "issue", "lot", "surprise", "beauty", "secret", "choice", "exercise", "time",
]);
const namesByCopula = (text: string): boolean => {
  const complement = NAMING_COPULA.exec(text)?.[1];
  return complement !== undefined && !complement.toLowerCase().split(/\s+/).some((word) => VERDICT_WORDS.has(word));
};
const ITEM = "[^\\s.!?:;,][^.!?:;,]{0,40}?";
const COLON_TRICOLON = new RegExp(`(?<!\\d):\\s+${ITEM},\\s+${ITEM},?\\s+(?:and|or)\\s+${ITEM}[.!?]["”’)]*$`, "i");
const NUMBER_WORD = "(?:two|three|four|five|six|seven|eight|nine|ten)";
const TEASERS = [
  /\bby the end(?: of (?:this|this video|the video|it))?,?\s+you(?:['’]ll| will)?\s+(?:be able to|can|know|understand|see)\b/i,
  new RegExp(`^${NUMBER_WORD}\\s+(?:fixes|things|ways|changes|steps|tricks|moves|rules)\\s+(?:[\\w'’-]+\\s+){0,3}(?:that|this|it|everything)[.!?]`, "i"),
  /\bmore on (?:that|this) later\b/i,
  /\b(?:see you|until) next time\b|\bnext time,? we['’]ll\b/i,
];
const LABEL_FIRST = /^the (?:fix|answer|trick|key|solution|secret) is\s+\S/i;

/** Every spoken sentence in script order, with its word count as the register rows count it. */
export function hallmarkSentences(beats: readonly HallmarkBeat[]): HallmarkSentence[] {
  return beats.flatMap((beat) => {
    const parsed = spokenText([beat.spoken]);
    const lengths = sentenceLengths(parsed);
    return parsed.sentences.map((text, i) => ({ beat: beat.id, chapter: beat.chapter ?? "", text: text.trim(), words: lengths[i] ?? 0 }));
  });
}

const beatsOf = (sentences: readonly HallmarkSentence[]): string[] => sentences.map((sentence) => sentence.beat);

/** A short sentence whose main clause names a thing: "That is called X.", "We call this X.", "That gas is the rise." */
export const isNamingRefrain = (s: HallmarkSentence, maxWords: number): boolean => s.words <= maxWords && (NAMING_VERB.test(s.text) || namesByCopula(s.text));

function namingRefrainRow(sentences: readonly HallmarkSentence[], rule: Hallmarks["naming-refrain"]): GateRow {
  const hits = sentences.filter((s) => isNamingRefrain(s, rule.maxWords));
  const failing = hits.length >= rule.warnAt && rule.severity !== "report-only";
  const severity: GateSeverity = failing && hits.length < rule.errorAt ? "warning" : rule.severity;
  return { id: "hallmark:naming-refrain", value: hits.length, threshold: rule.errorAt, severity, pass: !failing, beats: failing ? [...new Set(beatsOf(hits))] : [] };
}

/** Runs of consecutive short sentences, per 1,000 words; a lone short sentence is no run. */
function staccatoRow(sentences: readonly HallmarkSentence[], words: number, rule: Hallmarks["staccato-run"]): GateRow {
  const runs: HallmarkSentence[][] = [];
  let run: HallmarkSentence[] = [];
  for (const sentence of [...sentences, undefined]) {
    if (sentence !== undefined && sentence.words > 0 && sentence.words <= rule.maxWords) run.push(sentence);
    else {
      if (run.length >= rule.runLength) runs.push(run);
      run = [];
    }
  }
  return cappedRow("hallmark:staccato-run", (1000 * runs.length) / Math.max(words, 1), rule, runs.flat().map((s) => s.beat));
}

function patternRow(id: string, sentences: readonly HallmarkSentence[], matches: (s: HallmarkSentence) => boolean, cap: { severity: GateSeverity; max: number }): GateRow {
  const hits = sentences.filter(matches);
  return cappedRow(id, hits.length, cap, beatsOf(hits));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const speaks = (spoken: string, term: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, "i").test(spokenText([spoken]).text);

/** A term a beat declares in new_terms after an earlier beat already speaks it. */
export interface EarlyTerm {
  term: string;
  spokenIn: string;
  declaredIn: string;
}

/** Every term spoken before the beat that declares it; compares script positions, never ids. */
export function earlyTerms(beats: readonly HallmarkBeat[]): EarlyTerm[] {
  return beats.flatMap((beat, at) => (beat.new_terms ?? []).flatMap((term) => {
    const first = beats.findIndex((other) => speaks(other.spoken, term));
    return first !== -1 && first < at ? [{ term, spokenIn: beats[first]!.id, declaredIn: beat.id }] : [];
  }));
}

function namedBeforeDefinedRow(beats: readonly HallmarkBeat[], rule: Hallmarks["named-before-defined"]): GateRow {
  const early = earlyTerms(beats);
  return cappedRow("hallmark:named-before-defined", early.length, rule, early.map((found) => found.spokenIn));
}

/**
 * The hallmark rows that read spoken text only, so plain text with no beats or terms can carry them. Under the
 * policy's minimum words they report only, as the gate rows do.
 */
export function textHallmarkRows(beats: readonly HallmarkBeat[], policy: WritingGatePolicy = writingGatePolicy()): GateRow[] {
  const words = spokenText(beats.map((beat) => beat.spoken)).words.length;
  const rows = hallmarkRowsOf(hallmarkSentences(beats), words, policy.hallmarks);
  return words < policy.minWords ? rows.map((row) => ({ ...row, severity: "report-only", pass: true, beats: [] })) : rows;
}

function hallmarkRowsOf(sentences: readonly HallmarkSentence[], words: number, rules: Hallmarks): GateRow[] {
  return [
    namingRefrainRow(sentences, rules["naming-refrain"]),
    frameRefrainRow(sentences, rules["frame-refrain"]),
    staccatoRow(sentences, words, rules["staccato-run"]),
    patternRow("hallmark:colon-tricolon", sentences, (s) => COLON_TRICOLON.test(s.text), rules["colon-tricolon"]),
    patternRow("hallmark:teaser", sentences, (s) => TEASERS.some((teaser) => teaser.test(s.text)), rules.teaser),
    parallelRecapRow(sentences, rules["parallel-recap"]),
    patternRow("hallmark:label-first", sentences, (s) => s.words <= rules["label-first"].maxWords && LABEL_FIRST.test(s.text), rules["label-first"]),
  ];
}

/** Q-V17 and Q-V18: the deterministic hallmarks of machine-drafted explainer prose (TP-5721), one row each. */
export const hallmarkCheck: L0Check = ({ script }) => {
  const policy = writingGatePolicy();
  return [...textHallmarkRows(script.beats, policy), namedBeforeDefinedRow(script.beats, policy.hallmarks["named-before-defined"])].map(gateL0Row);
};
