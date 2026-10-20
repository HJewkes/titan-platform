import { contentTerms } from "@titan-design/speech-vet";
import type { L0Result } from "./eval-l0.js";
import type { MapLayout } from "./map-state.js";
import type { RfIssue } from "./rf-script.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

export const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const wordsOf = (text: string): string[] => text.split(/\s+/).filter((w) => /\w/.test(w));

export { contentTerms };

export const sharesTerm = (a: string, b: string): boolean => {
  const left = contentTerms(a);
  return [...contentTerms(b)].some((term) => left.has(term));
};

/** A beat that only opens its chapter: the first beat, asked as a learner question. */
export function isChapterOpen(beat: ScriptBeat, index: number, beats: readonly ScriptBeat[]): boolean {
  return beat.function === "LEARNER_Q" && beats[index - 1]?.chapter !== beat.chapter;
}

/** Beats that carry the body of the video: no chapter opens and no close. */
export const bodyBeats = (beats: readonly ScriptBeat[]): ScriptBeat[] =>
  beats.filter((beat, i) => !isChapterOpen(beat, i, beats) && beat.function !== "CLOSE");

/** Start of each beat as a share of the planned runtime. */
export function startShares(beats: readonly ScriptBeat[]): Map<string, number> {
  const total = beats.reduce((sum, b) => sum + b.plannedS, 0);
  let elapsed = 0;
  return new Map(
    beats.map((b) => {
      const share = elapsed / total;
      elapsed += b.plannedS;
      return [b.id, share];
    }),
  );
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function entityForms(name: string): string[] {
  const lower = name.toLowerCase().trim();
  return [lower, lower.replace(/[/]/g, " slash "), lower.replace(/[_-]/g, " ")].filter((form) => form.length > 2);
}

/**
 * Repo entities named by the script itself: glossary, new terms, on-screen labels and map node ids.
 * A caller with a fuller list (a review's repo names) passes it as `extra`.
 */
export function repoEntities(script: ScriptV1, layout?: MapLayout, extra: readonly string[] = []): string[] {
  const named = [
    ...script.video.glossary.map((g) => g.name),
    ...script.beats.flatMap((b) => [...b.new_terms, ...b.visual.labels]),
    ...(layout?.nodes ?? []).map((n) => n.id),
    ...extra,
  ];
  return [...new Set(named.flatMap(entityForms))].sort((a, b) => b.length - a.length);
}

/** Blanks every repo entity, so a process word inside a name ("the review server") never matches. */
export function maskEntities(text: string, entities: readonly string[]): string {
  return entities.reduce(
    (masked, entity) => masked.replace(new RegExp(`\\b${escape(entity)}\\b`, "gi"), "ENTITY"),
    text,
  );
}

export interface RowInput {
  value: number;
  threshold: number;
  pass: boolean;
  beats?: Iterable<string>;
  mode?: L0Result["mode"];
  severity?: L0Result["severity"];
}

export const ruleRow = (check_id: string, input: RowInput): L0Result => ({
  check_id,
  mode: input.mode ?? "heuristic",
  severity: input.severity ?? "error",
  value: Number.isInteger(input.value) ? input.value : Math.round(input.value * 1000) / 1000,
  threshold: input.threshold,
  pass: input.pass,
  detail_beats: [...new Set(input.beats ?? [])],
});

/** A count rule: every beat that matched is a defect, and the bar is zero. */
export const countRow = (check_id: string, beats: readonly string[], mode?: L0Result["mode"]): L0Result =>
  ruleRow(check_id, { value: beats.length, threshold: 0, pass: beats.length === 0, beats, ...(mode ? { mode } : {}) });

// The RF text lints (build_script.py), ported to keep its issue set; messages match its printed lines.
const PRONUNCIATION = /\[([^\]]+)\]\(([^)]*)\)/g;
const STRUCTURE_MAX = 12;
const MAX_LIST_COMMAS = 5;
const RF_MAX_SENTENCE_WORDS = 25;
const UNITS = new Map(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    .split(" ")
    .map((word, value) => [word, value]),
);
const TENS = new Map("twenty thirty forty fifty sixty seventy eighty ninety".split(" ").map((word, i) => [word, 20 + 10 * i]));
const DIGITS = /^\d[\d,]*(?:\.\d+)?$/;
const NUMBERED_ID = /\b[A-Za-z]+\d+\w*\b/g;

export const RF_BANNED: readonly string[] = [
  "\\blet's\\b", "\\bsimply\\b", "\\beasy\\b", "\\bplease note\\b", "\\bin this video\\b", "\\byou'll learn\\b",
  "^there (is|are)\\b", "\\bchapter (one|two|three|four|five|six|seven|eight|nine|\\d)\\b",
  "\\b(we|I) (read|traced|checked|audited|found)\\b", "\\bthe audit\\b", "\\bthis audit\\b",
];

/** Spoken words, with pronunciation markup (`[word](/phonemes/)`) read as its bare word. */
export const rfWords = (text: string): string[] => text.replace(PRONUNCIATION, "$1").match(/[A-Za-z0-9'’-]+/g) ?? [];

/** Python's `s[:n]`: code points, not UTF-16 units. */
const head = (text: string, n: number): string => Array.from(text).slice(0, n).join("");

/** Python's `repr` of a pattern string, as the banned-pattern message prints it. */
function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = text.replaceAll("\\", "\\\\");
  return quote + (quote === "'" ? body.replaceAll("'", "\\'") : body) + quote;
}

/** Python's `{n:g}`: six significant digits, exponent form outside 1e-4..1e6. */
function formatG(n: number): string {
  const [mantissa = "0", exponent = "0"] = n.toExponential(5).split("e");
  const exp = Number(exponent);
  if (exp >= -4 && exp < 6) return String(Number(n.toPrecision(6)));
  return `${mantissa.replace(/\.?0+$/, "")}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

const beatIssue = (beat: string, check: string, message: string, severity: RfIssue["severity"] = "error"): RfIssue => ({ beat, check, severity, message });

/** Q-V9, the banned phrases (Q-V1/V4/V7) and a possible long spoken list (Q-F9), per sentence of a beat. */
export function rfSentenceIssues(beatId: string, spoken: string, banned: readonly string[] = RF_BANNED): RfIssue[] {
  return sentencesOf(spoken).flatMap((sentence) => {
    const count = rfWords(sentence).length;
    const quoted = head(sentence, 60);
    return [
      ...(count > RF_MAX_SENTENCE_WORDS ? [beatIssue(beatId, "Q-V9", `sentence of ${count} words: ${quoted}…`)] : []),
      ...banned
        .filter((pattern) => new RegExp(pattern, "i").test(sentence))
        .map((pattern) => beatIssue(beatId, "Q-V1/V4/V7", `banned pattern ${pyRepr(pattern)} in: ${quoted}`)),
      ...((sentence.match(/,/g) ?? []).length >= MAX_LIST_COMMAS
        ? [beatIssue(beatId, "Q-F9", `possible spoken list over 5 items: ${quoted}`, "warn")]
        : []),
    ];
  });
}

type NumberKind = "unit" | "tens" | "scale" | undefined;

const numberKind = (token: string): NumberKind =>
  TENS.has(token) ? "tens" : token === "hundred" || token === "thousand" ? "scale" : UNITS.has(token) ? "unit" : undefined;

/** Number values in one clause's tokens: "three hundred and two" is 302, "fifty-one and a half" 51.5. */
function phraseValues(tokens: readonly string[]): number[] {
  const out: number[] = [];
  let [total, part, i] = [0, 0, 0];
  let prev: NumberKind;
  const flush = () => {
    out.push(total + part);
    [total, part] = [0, 0];
  };
  while (i < tokens.length) {
    const token = tokens[i]!;
    const kind = numberKind(token);
    if (prev && token === "and" && tokens[i + 1] === "a" && tokens[i + 2] === "half") {
      [part, i] = [part + 0.5, i + 3];
      continue;
    }
    if (prev === "scale" && token === "and" && numberKind(tokens[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    const isCount = kind === "unit" || kind === "tens";
    const joins = prev === undefined || prev === "scale" || (prev === "tens" && kind === "unit" && UNITS.get(token)! < 10);
    if (isCount && !joins) flush();
    if (isCount) part += UNITS.get(token) ?? TENS.get(token)!;
    else if (token === "hundred") part = (part || 1) * 100;
    else if (token === "thousand") [total, part] = [total + (part || 1) * 1000, 0];
    else if (DIGITS.test(token)) out.push(Number(token.replaceAll(",", "")));
    else if (prev) flush();
    [prev, i] = [kind, i + 1];
  }
  return prev ? [...out, total + part] : out;
}

/** Every quantity a line speaks. Identifiers (F12, M8, Q10) and ordinals are not quantities. */
export function spokenNumbers(text: string, allowedPhrases?: RegExp): number[] {
  const lower = text.toLowerCase();
  const phrases = allowedPhrases && new RegExp(allowedPhrases.source, `${allowedPhrases.flags.replace("g", "")}g`);
  const plain = (phrases ? lower.replace(phrases, " ") : lower).replace(NUMBERED_ID, " ");
  return plain
    .split(/[.,;:!?()–—]/)
    .flatMap((clause) => phraseValues(clause.replaceAll("-", " ").match(/\d[\d,]*(?:\.\d+)?|[a-z]+/g) ?? []));
}

export interface NumberPolicy {
  /** Quantities the video's facts pack lets narration state. Counts up to 12 are structure and always allowed. */
  allowedNumbers: readonly number[];
  /** Phrases removed before counting, such as a stated range. */
  allowedPhrases?: RegExp;
}

/** The numbers rule: new narration states only fact-list quantities or counts of the design's own parts. */
export const rfNumberIssues = (beatId: string, spoken: string, policy: NumberPolicy): RfIssue[] =>
  spokenNumbers(spoken, policy.allowedPhrases)
    .filter((n) => n > STRUCTURE_MAX && !policy.allowedNumbers.includes(n))
    .map((n) => beatIssue(beatId, "numbers", `${formatG(n)} is not on the fact list`));
