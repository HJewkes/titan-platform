import type { L0Result } from "./eval-l0.js";
import { earlyTerms, hallmarkSentences, isNamingRefrain } from "./lint-hallmarks.js";
import { clipped, listed, namedBeats, type Hint } from "./repair-hint.js";
import type { ScriptV1 } from "./script-schema.js";
import { writingGatePolicy } from "./writing-gate-policy.js";

function namingQuotes(script: ScriptV1, row: L0Result): string {
  const { maxWords } = writingGatePolicy().hallmarks["naming-refrain"];
  return hallmarkSentences(namedBeats(script, row)).filter((s) => isNamingRefrain(s, maxWords)).map((s) => `${s.beat} "${clipped(s.text)}"`).join("; ");
}

function shortRegisterHint(_script: ScriptV1, row: L0Result): string {
  const { longShareBelow } = writingGatePolicy().gate["short-register"];
  return `the spoken sentences average ${row.value} words (at least ${row.threshold} needed) and under ${Math.round(longShareBelow * 100)} % of them run past ${writingGatePolicy().longWords} words: the short, even register a listener hears as machine prose. Join neighbouring short sentences that share a subject into one that carries its reason (because, so, which, until), and cut lines that only restate the one before`;
}

function namedBeforeDefinedHint(script: ScriptV1): string {
  const found = earlyTerms(script.beats).map(({ term, spokenIn, declaredIn }) => `"${term}" is spoken in ${spokenIn} but declared in ${declaredIn}`);
  return `${found.join("; ")}. Declare each term in new_terms of the beat that first speaks it and define it there, or keep it out of the earlier beats`;
}

const named = (row: L0Result): string => listed(row.detail_beats);

/** The writing gate and hallmark rows (TP-5721): Q-V16, Q-V17 and Q-V18. */
export const WRITING_HINTS: Readonly<Record<string, Hint>> = {
  "writing:short-register": shortRegisterHint,
  "hallmark:naming-refrain": (script, row) =>
    `${row.value} short sentences only name a thing: ${namingQuotes(script, row)}. Name each thing once, inside the sentence that puts it to work, and cut the standalone naming lines`,
  "hallmark:frame-refrain": (_script, row) =>
    `${row.value} sentences in one chapter open on the same three words (${named(row)}); open each on what it is about instead`,
  "hallmark:staccato-run": (_script, row) =>
    `runs of very short sentences come ${row.value} times a thousand words (at most ${row.threshold}) in ${named(row)}; join each run into one sentence that says how its parts connect`,
  "hallmark:colon-tricolon": (_script, row) =>
    `${named(row)} end a sentence on a colon and a list of three; say the point as a plain clause, with the one item that matters`,
  "hallmark:teaser": (_script, row) =>
    `${named(row)} tease or promise instead of explaining ("By the end of this, you'll be able to", "three fixes change that", "more on that later"); state the question the video settles, or the thing itself`,
  "hallmark:parallel-recap": (_script, row) =>
    `${named(row)} recap in a run of short sentences that open on the same word; keep the one that carries the point, or join them with their reasons`,
  "hallmark:label-first": (_script, row) =>
    `${named(row)} announce a label ("The fix is X.") before the reasoning; lead with what happens, and let the name land inside that sentence`,
  "hallmark:named-before-defined": namedBeforeDefinedHint,
};
