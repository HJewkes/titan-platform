import { misakiEnglish, type G2p } from "@titan-design/speech-g2p";
import type { L0Check } from "./eval-l0.js";
import { countRow, wordsOf } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// Geometry of the headline band, from the explainer chrome stylesheet: `.xp-band-top` is padded by
// `--xp-edge` on each side of a 1920 px canvas and sized for two lines of `.xp-headline`, whose font size is
// `--beat-body` (48 px) times 1.3, with `overflow: hidden`. A third line is clipped, not shown.
const CANVAS_WIDTH_PX = 1920;
const BAND_EDGE_PX = 60;
const BEAT_BODY_PX = 48;
const HEADLINE_SCALE = 1.3;
export const HEADLINE_MAX_LINES = 2;

// Mean advance of the heading face as a share of its font size, rounded up so the estimate errs towards a wrap.
const AVERAGE_CHAR_EM = 0.52;

export const HEADLINE_CHARS_PER_LINE = Math.floor((CANVAS_WIDTH_PX - 2 * BAND_EDGE_PX) / (BEAT_BODY_PX * HEADLINE_SCALE * AVERAGE_CHAR_EM));

/** Lines a greedy word wrap gives the headline; a word wider than a line takes the lines it needs. */
export function headlineLines(headline: string, charsPerLine = HEADLINE_CHARS_PER_LINE): number {
  let lines = 1;
  let used = 0;
  for (const word of headline.split(/\s+/).filter(Boolean)) {
    const fit = used === 0 ? word.length : used + 1 + word.length;
    if (fit <= charsPerLine) {
      used = fit;
      continue;
    }
    if (used > 0) lines += 1;
    lines += Math.floor((word.length - 1) / charsPerLine);
    used = ((word.length - 1) % charsPerLine) + 1;
  }
  return lines;
}

const headlineOf = (beat: ScriptBeat): string => beat.visual.assertion;

export const overlongHeadlines = (beats: readonly ScriptBeat[]): ScriptBeat[] =>
  beats.filter((beat) => headlineLines(headlineOf(beat)) > HEADLINE_MAX_LINES);

/** Q-V13: a beat headline wraps to at most two lines at the band's width, so the band never clips it. */
export const headlineCheck: L0Check = ({ script }) => [countRow("Q-V13", overlongHeadlines(script.beats).map((beat) => beat.id))];

export const ASSERTION_MAX_WORDS = 10;

// Penn tags of a finite verb: a headline needs one to assert something rather than name a topic.
const FINITE_VERB_TAGS: ReadonlySet<string> = new Set(["VBZ", "VBP", "VBD", "MD"]);

/** Penn part-of-speech tags, one per token. */
export type Tagger = (text: string) => string[];

let g2p: G2p | undefined;
// Built on first use: loading the G2P lexicon takes about a second, so only a run that reads a headline pays it.
const g2pTags: Tagger = (text) => (g2p ??= misakiEnglish()).tokens(text).map((token) => token.tag);

/**
 * Simple past forms that are never also a participle or a common noun, so a word after the first that is one is a
 * finite verb whatever the tagger reads: misaki tags "drew" NNP in "Daily video drew most merges". "made", "led" and
 * "found" are left out, since a topic label uses them as participles ("Labels made at the desk").
 */
const IRREGULAR_PAST: ReadonlySet<string> = new Set([
  "arose", "ate", "awoke", "became", "began", "came", "chose", "did", "drank", "drew", "flew", "forgave", "forgot", "froze",
  "gave", "grew", "hid", "knew", "overtook", "ran", "rang", "redrew", "rewrote", "rode", "sang", "shook", "shrank", "swam",
  "swore", "took", "threw", "tore", "underwent", "went", "withdrew", "woke", "wore", "wrote",
]);

const saysIrregularPast = (headline: string): boolean =>
  wordsOf(headline).slice(1).some((word) => IRREGULAR_PAST.has(word.toLowerCase().replace(/[^a-z]/g, "")));

/**
 * A finite verb after the first token: a subject and its verb. A topic label has none, and a bare imperative's verb
 * comes first. An irregular past the tagger misreads counts as one too.
 */
export const hasSubjectAndVerb = (headline: string, tag: Tagger = g2pTags): boolean =>
  tag(headline).some((each, i) => i > 0 && FINITE_VERB_TAGS.has(each)) || saysIrregularPast(headline);

export type AssertionDefect = "over-ten-words" | "no-subject-verb" | "written-after-narration";

/** What keeps a beat's headline from being an assertion: its length, its missing verb, or a narration written first. */
export function assertionDefects(beat: ScriptBeat, tag: Tagger = g2pTags): AssertionDefect[] {
  const headline = headlineOf(beat);
  const defects: AssertionDefect[] = [];
  if (wordsOf(headline).length > ASSERTION_MAX_WORDS) defects.push("over-ten-words");
  if (!hasSubjectAndVerb(headline, tag)) defects.push("no-subject-verb");
  if (beat.authored && Date.parse(beat.authored.assertion_at) > Date.parse(beat.authored.spoken_at)) defects.push("written-after-narration");
  return defects;
}

/** Q-D7: every beat's headline asserts its point, a subject and a verb in at most ten words, written before its narration. */
export function assertionCheckWith(tag: Tagger = g2pTags): L0Check {
  return ({ script }) => [countRow("Q-D7", script.beats.filter((beat) => assertionDefects(beat, tag).length > 0).map((beat) => beat.id))];
}

export const assertionCheck: L0Check = assertionCheckWith();
