import type { L0Check, L0Result } from "./eval-l0.js";
import {
  bodyBeats,
  contentTerms,
  countRow,
  isChapterOpen,
  type NumberPolicy,
  rfNumberIssues,
  rfSentenceIssues,
  rfWords,
  ruleRow,
  sentencesOf,
  sharesTerm,
  startShares,
  wordsOf,
} from "./lint-text.js";
import { mapSides, type RfBeat, type RfIssue, type RfScript } from "./rf-script.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

const CONNECTIVE = /^(but|so|therefore|because|yet|then|instead|however|otherwise|still|that is why|which means)\b/i;
const ANNOUNCEMENT = /^(here is|here's|now \w+|two more|three more|zoom (in|out)|next)\b/i;
const ANAPHORA = /^(this|that|these|those|it|its|they|their)\b/i;
const TURN = /^(but|so|therefore)\b/i;
const PIVOT = /\bwhat it does\b[^.?!]*\bhow\b|\bnow,? how (does|do|is)\b/i;
const GOOD_QUESTION = /^(why|how (does|do|did|can|could|come|is|are))\b|\b(you|your)\b/i;
const RECAP = /\b(to recap|in summary|recap|we (saw|covered|learned))\b/i;
const CAUSAL = /\b(but|so|therefore|because|which means|otherwise)\b/gi;
const HAS_CAUSAL = new RegExp(CAUSAL.source, "i");
const IDENTIFIER = /[a-z][A-Z]|_|\/|\w\.\w|^slash$/;
export const MIN_LINKED = 0.7;
export const MAX_CONNECTIVE_SHARE = 0.4;
export const MIN_HANDOFFS = 2 / 3;
export const MAX_LIST_ITEMS = 5;
export const MAX_OUTRO_WORDS = 8;
export const BEAT_SECONDS = [6, 20] as const;
export const MIN_CAUSAL_DENSITY = 0.5;
export const MIN_PLAIN_SHARE = 0.4;

const first = (spoken: string): string => sentencesOf(spoken)[0] ?? "";
const last = (spoken: string): string => sentencesOf(spoken).at(-1) ?? "";
const isTodo = (value: unknown): value is string => typeof value === "string" && value.startsWith("TODO:");
const connectiveOf = (beat: ScriptBeat): string | undefined =>
  beat.connector_in ?? CONNECTIVE.exec(first(beat.spoken))?.[1]?.toLowerCase();

/** Q-F1: body-to-body boundaries inside a chapter link by a connective or a shared entity. */
function boundaryLinks(beats: readonly ScriptBeat[]): L0Result {
  const boundaries = beats.flatMap((beat, i) => {
    const prev = beats[i - 1];
    return prev && prev.chapter === beat.chapter && !isChapterOpen(prev, i - 1, beats) ? [{ prev, beat }] : [];
  });
  const linked = boundaries.filter(
    ({ prev, beat }) => !ANNOUNCEMENT.test(first(beat.spoken)) && (connectiveOf(beat) !== undefined || ANAPHORA.test(first(beat.spoken)) || sharesTerm(last(prev.spoken), first(beat.spoken))),
  );
  const counts = new Map<string, number>();
  for (const { beat } of linked) {
    const word = connectiveOf(beat);
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const overused = linked.length >= 3 && [...counts.values()].some((n) => n / linked.length > MAX_CONNECTIVE_SHARE);
  const ratio = boundaries.length ? linked.length / boundaries.length : 1;
  const unlinked = boundaries.filter((b) => !linked.includes(b)).map(({ beat }) => beat.id);
  return ruleRow("Q-F1", { value: ratio, threshold: MIN_LINKED, pass: ratio >= MIN_LINKED && !overused, beats: unlinked });
}

/** Q-F2: a chapter ends on a turn or a question that the next chapter's open picks up. */
function chapterHandoffs(beats: readonly ScriptBeat[]): L0Result {
  const handoffs = beats.flatMap((beat, i) => {
    const prev = beats[i - 1];
    return prev && prev.chapter !== beat.chapter ? [{ prev, beat }] : [];
  });
  const held = handoffs.filter(({ prev, beat }) => {
    if (beat.connector_in) return true;
    const ending = last(prev.spoken);
    return (ending.endsWith("?") || TURN.test(ending)) && sharesTerm(ending, beat.spoken);
  });
  const ratio = handoffs.length ? held.length / handoffs.length : 1;
  const dropped = handoffs.filter((h) => !held.includes(h)).map(({ beat }) => beat.id);
  return ruleRow("Q-F2", { value: ratio, threshold: MIN_HANDOFFS, pass: ratio >= MIN_HANDOFFS, beats: dropped, mode: "tagged" });
}

const voices = (spoken: string, claim: string): boolean => {
  const terms = [...contentTerms(claim)];
  const said = contentTerms(spoken);
  return terms.length > 0 && terms.filter((t) => said.has(t)).length / terms.length >= 0.6;
};

/** Q-F4: the thesis lands at the open, the midpoint and the button, and its mechanism is said in act 1–2. */
function thesisPlacement({ video, beats }: ScriptV1): L0Result {
  const shares = startShares(beats);
  const [open, mid, button] = (video.thesis_refs ?? []).map((id) => shares.get(id) ?? -1);
  const misplaced = [
    open === undefined || open > 0.2,
    mid === undefined || mid < 0.35 || mid > 0.65,
    button === undefined || button < 0.8,
  ].filter(Boolean).length;
  const actOneTwo = beats.filter((b) => (shares.get(b.id) ?? 1) < 0.2);
  const voiced = !isTodo(video.thesis_mechanism) && actOneTwo.some((b) => voices(b.spoken, video.thesis_mechanism));
  const defects = misplaced + (voiced ? 0 : 1);
  return ruleRow("Q-F4", { value: defects, threshold: 0, pass: defects === 0, beats: video.thesis_refs ?? [], mode: "tagged" });
}

function pivotLines(beats: readonly ScriptBeat[]): L0Result {
  const pivots = beats.flatMap((beat) => sentencesOf(beat.spoken).filter((s) => PIVOT.test(s)).map(() => beat.id));
  return ruleRow("Q-F5", { value: pivots.length, threshold: 1, pass: pivots.length === 1, beats: pivots });
}

const firstBeatOf = (beats: readonly ScriptBeat[], chapter: string): string => beats.find((b) => b.chapter === chapter)?.id ?? chapter;

const weakQuestions = ({ chapters, beats }: ScriptV1): string[] =>
  chapters.filter((c) => !GOOD_QUESTION.test(c.question.trim())).map((c) => firstBeatOf(beats, c.id));

const overloadedBeats = (beats: readonly ScriptBeat[]): string[] =>
  bodyBeats(beats)
    .filter((b) => b.new_terms.length > 2 || b.plannedS < BEAT_SECONDS[0] || b.plannedS > BEAT_SECONDS[1])
    .map((b) => b.id);

/** Items in a spoken list: commas, plus one for an "x and y" tail; a colon starts the list. */
function listItems(sentence: string): number {
  const list = sentence.slice(sentence.lastIndexOf(":") + 1);
  const segments = list.split(",");
  if (segments.length < 3 && !(segments.length === 2 && /\s(and|or)\s/.test(list))) return 0;
  const tail = segments.at(-1)!.trim().replace(/^(and|or)\s+/i, "");
  return segments.length + (/\S\s+(and|or)\s+\S/.test(tail) ? 1 : 0);
}

const identifiers = (text: string): number => wordsOf(text).filter((w) => IDENTIFIER.test(w.replace(/[.,;:!?]+$/, ""))).length;

/** Q-F9: spoken lists stay short, and names or paths read aloud in bulk belong on a `ref` beat. */
const longLists = (beats: readonly ScriptBeat[]): string[] =>
  beats
    .filter((b) => sentencesOf(b.spoken).some((s) => listItems(s) > MAX_LIST_ITEMS) || (b.mode !== "ref" && identifiers(b.spoken) >= 3))
    .map((b) => b.id);

/** Q-F10: a SIGN or VERDICT beat never interrupts the WHAT/HOW run inside a chapter. */
function interruptions(beats: readonly ScriptBeat[]): string[] {
  const aside = (b: ScriptBeat) => b.function === "SIGN" || b.function === "VERDICT";
  const body = (b: ScriptBeat | undefined, chapter: string) => b?.chapter === chapter && (b.function === "WHAT" || b.function === "HOW");
  return beats
    .filter((beat, i) => {
      if (!aside(beat)) return false;
      const before = beats.slice(0, i).reverse().find((b) => !aside(b));
      const after = beats.slice(i + 1).find((b) => !aside(b));
      return body(before, beat.chapter) && body(after, beat.chapter);
    })
    .map((b) => b.id);
}

/** Q-F11: a typed close, no recap, and a short outro that does not send the viewer off to read. */
function closeDefects({ video, beats }: ScriptV1): string[] {
  const closes = beats.filter((b) => b.function === "CLOSE");
  const outro = beats.at(-1);
  if (!outro) return [];
  return [
    ...(closes.length === 0 || isTodo(video.close_type) ? [outro.id] : []),
    ...closes.filter((b) => RECAP.test(b.spoken) || sentencesOf(b.spoken).some((s) => listItems(s) >= 3)).map((b) => b.id),
    ...(wordsOf(outro.spoken).length > MAX_OUTRO_WORDS ? [outro.id] : []),
    ...[...new Set([...closes, outro])].filter((b) => /\bstart reading\b/i.test(b.spoken)).map((b) => b.id),
  ];
}

function causalDensity(beats: readonly ScriptBeat[]): L0Result {
  const body = bodyBeats(beats);
  const hits = body.reduce((sum, b) => sum + (b.spoken.match(CAUSAL) ?? []).length, 0);
  const density = body.length ? hits / body.length : 0;
  const flat = body.filter((b) => !HAS_CAUSAL.test(b.spoken)).map((b) => b.id);
  return ruleRow("Q-F14", { value: density, threshold: MIN_CAUSAL_DENSITY, pass: density >= MIN_CAUSAL_DENSITY, beats: flat, severity: "warning" });
}

/** Q-F15: each HOW chapter asks the viewer's question somewhere past its open. */
function learnerQuestions(beats: readonly ScriptBeat[]): L0Result {
  const asks = (b: ScriptBeat, i: number) =>
    !isChapterOpen(b, i, beats) && (b.function === "LEARNER_Q" || sentencesOf(b.spoken).some((s) => s.endsWith("?")));
  const howChapters = [...new Set(beats.filter((b) => b.function === "HOW").map((b) => b.chapter))];
  const silent = howChapters.filter((c) => !beats.some((b, i) => b.chapter === c && asks(b, i)));
  const ids = silent.map((c) => firstBeatOf(beats, c));
  return ruleRow("Q-F15", { value: silent.length, threshold: 0, pass: silent.length === 0, beats: ids, severity: "warning" });
}

/** Q-F16: the plain-language share of the script before the first internal identifier is spoken. */
function plainOpening(beats: readonly ScriptBeat[]): L0Result {
  const words = beats.flatMap((b) => wordsOf(b.spoken).map((word) => ({ id: b.id, word: word.replace(/[.,;:!?]+$/, "") })));
  const at = words.findIndex(({ word }) => IDENTIFIER.test(word));
  const share = at === -1 || words.length === 0 ? 1 : at / words.length;
  const beat = at === -1 ? [] : [words[at]!.id];
  return ruleRow("Q-F16", { value: share, threshold: MIN_PLAIN_SHARE, pass: share >= MIN_PLAIN_SHARE, beats: beat });
}

/** Q-F flow lints over the spoken track and the beat functions. */
export const flowCheck: L0Check = ({ script }) => {
  const { beats } = script;
  return [
    boundaryLinks(beats),
    chapterHandoffs(beats),
    thesisPlacement(script),
    pivotLines(beats),
    countRow("Q-F7", weakQuestions(script)),
    countRow("Q-F8", overloadedBeats(beats), "tagged"),
    countRow("Q-F9", longLists(beats)),
    countRow("Q-F10", interruptions(beats), "tagged"),
    countRow("Q-F11", closeDefects(script)),
    causalDensity(beats),
    learnerQuestions(beats),
    plainOpening(beats),
  ];
};

const STAKE_BY = 0.15;
const RULE3_MAX_ITEMS = 4;
const RULE5_DENSE_ITEMS = 3;
const CHIP_ROWS = 7;
const LIST_KINDS: Record<string, ReadonlySet<string>> = {
  HookBeat: new Set(["card", "fan", "rule"]),
  ListBeat: new Set(["row", "rows", "col", "stamp", "left", "right", "risk", "open"]),
};

/** What one video's RF lint run allows; the frozen scripts each carried their own copy in build_script.py. */
export interface RfTextProfile extends NumberPolicy {
  /** Word cap on the last beat: the v4 tagline's 8, or a closing CLOSE beat's 25. */
  outroMaxWords?: number;
  /** The owner's script rules 3 (a list shows at most 4 items) and 5 (no dense list straight after another). */
  ownerRules?: boolean;
  banned?: readonly string[];
}

const scriptIssue = (check: string, message: string): RfIssue => ({ beat: null, check, severity: "error", message });

/** Q-W1: the first STAKE beat starts within 15 % of the planned runtime. */
function stakeIssues(beats: readonly RfBeat[]): RfIssue[] {
  const total = beats.reduce((sum, b) => sum + b.plannedS, 0);
  const stake = beats.findIndex((b) => b.function === "STAKE");
  const stakeAt = beats.slice(0, stake === -1 ? beats.length : stake).reduce((sum, b) => sum + b.plannedS, 0);
  return stakeAt > STAKE_BY * total ? [scriptIssue("Q-W1", "stake after 15%")] : [];
}

function outroIssues(beats: readonly RfBeat[], cap: number): RfIssue[] {
  const outro = beats.at(-1);
  return outro && rfWords(outro.spoken).length > cap ? [scriptIssue("Q-F11", `outro over ${cap} words`)] : [];
}

/** The items a list-like beat shows: HookBeat cards, ListBeat rows, or the longer side of a CompareBeat. */
function shownItems({ visual }: RfBeat): number {
  const kinds = visual.cues.map((c) => c.target.split(":")[0]!);
  if (visual.render === "CompareBeat") return Math.max(...["left", "right"].map((side) => kinds.filter((k) => k === side).length));
  const listed = LIST_KINDS[visual.render];
  return listed ? kinds.filter((k) => listed.has(k)).length : 0;
}

/** Owner rules 3 and 5; the edge table is one growing table, not a list, so it is exempt. */
function ownerRuleIssues(beats: readonly RfBeat[]): RfIssue[] {
  const dense = (b: RfBeat) => b.visual.render in LIST_KINDS && shownItems(b) >= RULE5_DENSE_ITEMS;
  const long = beats
    .filter((b) => shownItems(b) > RULE3_MAX_ITEMS)
    .map((b): RfIssue => ({ beat: b.id, check: "rule3", severity: "error", message: `${shownItems(b)} items, cap ${RULE3_MAX_ITEMS}` }));
  const adjacent = beats.flatMap((b, i): RfIssue[] => {
    const prev = beats[i - 1];
    return prev && dense(prev) && dense(b) ? [{ beat: b.id, check: "rule5", severity: "error", message: `a dense list straight after ${prev.id}` }] : [];
  });
  return [...long, ...adjacent];
}

/** The item camera's chip panel holds 7 rows: at most that many distinct chips on one chapter's item. */
function chipRowIssues(beats: readonly RfBeat[]): RfIssue[] {
  const seen = new Map<string, Set<string>>();
  for (const b of beats) {
    const chips = seen.get(b.chapter) ?? new Set<string>();
    seen.set(b.chapter, chips);
    for (const side of mapSides(b.visual.map_state)) for (const chip of side.item?.chips ?? []) chips.add(chip.text);
  }
  return [...seen]
    .filter(([, chips]) => chips.size > CHIP_ROWS)
    .map(([chapter, chips]) => ({ beat: chapter, check: "chips", severity: "error", message: `${chips.size} distinct chips on one item, cap ${CHIP_ROWS}` }));
}

/** A beat's own text lints; the numbers rule reads only new (`origin: v4`) narration, since reused audio cannot change. */
const beatTextIssues = (b: RfBeat, profile: RfTextProfile): RfIssue[] => [
  ...(b.origin === "v4" ? rfNumberIssues(b.id, b.spoken, profile) : []),
  ...rfSentenceIssues(b.id, b.spoken, profile.banned),
];

/** The build_script.py text lints (L1): bands, banned phrases, numbers, outro length, owner rules 3/5 and chip rows. */
export function rfTextLint(script: RfScript, profile: RfTextProfile): RfIssue[] {
  const { beats } = script;
  return [
    ...chipRowIssues(beats),
    ...(profile.ownerRules ? ownerRuleIssues(beats) : []),
    ...beats.flatMap((b) => beatTextIssues(b, profile)),
    ...stakeIssues(beats),
    ...outroIssues(beats, profile.outroMaxWords ?? MAX_OUTRO_WORDS),
  ];
}
