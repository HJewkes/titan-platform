import type { L0Check, L0Input, L0Result } from "./eval-l0.js";
import { countRow, maskEntities, repoEntities, ruleRow, sentencesOf, wordsOf } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// Lexicons are heuristics a judge backs up (L1 J1). Paraphrases evade them on purpose: the held-out
// synonym list lives with the judge, never here, so a writer cannot be tuned against it.
const PROCESS = [
  /\b(we|our|us)\b[^.?!]{0,30}\b(review|audit|check|trac|read|follow|reconstruct|verif|inspect)/i,
  /\b(the|our|this) (review|audit|analysis)\b/i,
  /\btraced by\b|\breconstructed\b|\bworth reading\b/i,
  /\bclaims?\b[^.?!]{0,20}\b(checked|held|audited|verified|refuted)\b/i,
  /\b(checked|audited|verified)\b[^.?!]{0,30}\bclaims?\b/i,
];
const PROVENANCE = /\b(docs? claim|from (the )?review|traced by reading|reconstructed|our framing|critique)\b|§|\bSUMMARY\b/i;
const INTERNAL_ID = /\b[A-Z]+-[A-Z0-9]+-\d+\b/;
const VERDICT = /\b(adopt|adapt|verdicts?|scorecard)\b|\b(do not|don't|not to) (copy|vendor|adopt)\b|\bavoid (it|that|this)\b/i;
const CHAPTER_NUMBER = /\bchapter (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const SIGNPOST = /^(chapter \w+\.$|here is|here's|zoom (in|out)|once more|now \w+\.$|follow the|next,|first,)/i;
const FIRST_PLURAL = /\b(we|our|us)\b/i;
const BANNED = [/\blet['’]s\b/i, /\bsimply\b/i, /\beas(y|ily)\b/i, /\bplease note\b/i, /\bin this video\b/i, /\byou('ll| will) learn\b/i, /^there (is|are)\b/i];
const POINTING = /\b(on|at) the (left|right|top|bottom)\b|\bas you can see\b|\blook at\b|\bnotice the\b|\bthis (box|arrow|line|node|panel)\b|\b(up|down|over) (here|there)\b/i;
const POINTING_CUES = new Set(["V6", "V9"]);
export const MAX_SENTENCE_WORDS = 25;
export const MIN_PROJECT_SHARE = 0.8;

const isProcess = (sentence: string, entities: readonly string[]): boolean => {
  const masked = maskEntities(sentence, entities);
  return PROCESS.some((pattern) => pattern.test(masked));
};

type Sentence = { beat: ScriptBeat; text: string };
const sentences = (beats: readonly ScriptBeat[]): Sentence[] =>
  beats.flatMap((beat) => sentencesOf(beat.spoken).map((text) => ({ beat, text })));

function sentenceRule(check_id: string, matched: Sentence[]): L0Result {
  return ruleRow(check_id, { value: matched.length, threshold: 0, pass: matched.length === 0, beats: matched.map((s) => s.beat.id) });
}

function provenanceLeaks(beats: readonly ScriptBeat[]): string[] {
  return beats
    .filter((beat) => [beat.spoken, beat.visual.assertion, ...beat.visual.labels].some((t) => PROVENANCE.test(t) || INTERNAL_ID.test(t)))
    .map((beat) => beat.id);
}

/** Verdict words outside VERDICT beats, and VERDICT beats placed before their chapter's last HOW. */
function misplacedVerdicts(beats: readonly ScriptBeat[]): string[] {
  const lastHow = new Map<string, number>();
  beats.forEach((beat, i) => beat.function === "HOW" && lastHow.set(beat.chapter, i));
  return beats
    .filter((beat, i) =>
      beat.function === "VERDICT" ? i < (lastHow.get(beat.chapter) ?? -1) : sentencesOf(beat.spoken).some((s) => VERDICT.test(s)),
    )
    .map((beat) => beat.id);
}

function projectShare(beats: readonly ScriptBeat[], entities: readonly string[]): L0Result {
  const spoken = sentences(beats.filter((beat) => beat.function !== "VERDICT"));
  const other = spoken.filter(
    ({ text }) => SIGNPOST.test(text) || VERDICT.test(text) || FIRST_PLURAL.test(text) || isProcess(text, entities),
  );
  const share = spoken.length ? (spoken.length - other.length) / spoken.length : 1;
  const beatsWithOther = other.map((s) => s.beat.id);
  return ruleRow("Q-V5", { value: share, threshold: MIN_PROJECT_SHARE, pass: share >= MIN_PROJECT_SHARE, beats: beatsWithOther });
}

const unanchoredPointing = (beats: readonly ScriptBeat[]): string[] =>
  beats
    .filter((beat) => POINTING.test(beat.spoken) && !beat.visual.cues.some((cue) => POINTING_CUES.has(cue.action)))
    .map((beat) => beat.id);

function spokenSignposts({ script }: L0Input): string[] {
  const chapterLabels = script.chapters.filter((c) => /^chapter\b/i.test(c.label)).map((c) => c.id);
  return [...script.beats.filter((beat) => CHAPTER_NUMBER.test(beat.spoken)).map((beat) => beat.id), ...chapterLabels];
}

/**
 * Q-V voice lints. Process words are matched after blanking repo entities, so "the review server" is
 * a part, not our review. `entities` adds names the script does not carry, such as a review's repo names.
 */
export function voiceCheckWith(entities: readonly string[] = []): L0Check {
  return (input) => {
    const { script, layout } = input;
    const known = repoEntities(script, layout, entities);
    const all = sentences(script.beats);
    return [
      sentenceRule("Q-V1", all.filter(({ text }) => isProcess(text, known))),
      countRow("Q-V2", provenanceLeaks(script.beats)),
      countRow("Q-V3", misplacedVerdicts(script.beats)),
      countRow("Q-V4", spokenSignposts(input)),
      projectShare(script.beats, known),
      sentenceRule("Q-V7", all.filter(({ text }) => BANNED.some((pattern) => pattern.test(text)))),
      countRow("Q-V8", unanchoredPointing(script.beats)),
      sentenceRule("Q-V9", all.filter(({ text }) => wordsOf(text).length > MAX_SENTENCE_WORDS)),
    ];
  };
}

export const voiceCheck: L0Check = voiceCheckWith();
