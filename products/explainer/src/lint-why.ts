import type { L0Check, L0Input, L0Result } from "./eval-l0.js";
import type { ScriptBeat, ScriptChapter, ScriptV1 } from "./script-schema.js";

/** The share of planned time by which the stake must be voiced. */
export const STAKE_BY_SHARE = 0.15;
/** The share of HOW beats that must walk the running example. */
export const THREAD_SHARE = 0.5;
export const MAX_DEMO_STEPS = 8;

const NUMBER = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|half|twice|double)\b/i;
// The why-or-value markers from eval-design S4; mechanism verbs never count.
const VALUE_MARKER = /\b(?:so that|which means|without (?:it|this|that)|the problems?|problems?|lets you|so you)\b/i;
const WHY_QUESTION = /^\s*(?:why|how come)\b/i;
const ABSENCE = /\b(?:never|always|every|nothing|no longer|cannot|can't|only)\b/i;
const CHAPTER_COUNT = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+\w+)?\s+chapters?\b/i;
const SHA = /^[0-9a-f]{7,40}$/;

const isTodo = (value: unknown): value is string => typeof value === "string" && value.startsWith("TODO:");
const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const firstSentence = (text: string): string => text.split(/(?<=[.?!])\s+/)[0] ?? text;

/** One row per rule. `beats` names the offenders; `scriptFailures` counts failures no beat owns. */
export function verdict(check_id: string, mode: L0Result["mode"], beats: string[], scriptFailures = 0): L0Result {
  const value = beats.length + scriptFailures;
  return { check_id, mode, severity: "error", value, threshold: 0, pass: value === 0, detail_beats: beats };
}

export function beatsOf(script: ScriptV1, chapter: ScriptChapter): ScriptBeat[] {
  return script.beats.filter((beat) => beat.chapter === chapter.id);
}

/** The body is every chapter between the opening act and the close. */
const bodyChapters = (script: ScriptV1): ScriptChapter[] => script.chapters.slice(1, -1);

// A chapter-open question or a signpost frames the chapter; its body starts after them.
const firstBodyBeat = (beats: ScriptBeat[]): ScriptBeat | undefined =>
  beats.find((beat) => beat.function !== "LEARNER_Q" && beat.function !== "SIGN");

const howChapters = (script: ScriptV1): ScriptChapter[] =>
  bodyChapters(script).filter((chapter) => beatsOf(script, chapter).some((beat) => beat.function === "HOW"));

function startTimes(script: ScriptV1): Map<string, number> {
  let at = 0;
  return new Map(
    script.beats.map((beat) => {
      const start = at;
      at += beat.plannedS;
      return [beat.id, start];
    }),
  );
}

function stakeVoiced(script: ScriptV1): L0Result {
  const stake = script.video.stake;
  if (isTodo(stake)) return verdict("Q-W1", "tagged", [], 1);
  const total = script.beats.reduce((sum, beat) => sum + beat.plannedS, 0);
  const starts = startTimes(script);
  const early = script.beats.filter((beat) => beat.function === "STAKE" && (starts.get(beat.id) ?? 0) < total * STAKE_BY_SHARE);
  const voiced = early.some((beat) => {
    const spoken = norm(beat.spoken);
    return (/\byou\b/.test(spoken) || spoken.includes(norm(stake.who))) && NUMBER.test(spoken);
  });
  return voiced ? verdict("Q-W1", "tagged", []) : verdict("Q-W1", "tagged", early.map((beat) => beat.id), early.length ? 0 : 1);
}

function whyForElements(script: ScriptV1): L0Result {
  const introduces = (beat: ScriptBeat) => beat.new_terms.length > 0 || (beat.visual.map_state?.reveal?.length ?? 0) > 0;
  const missing = script.beats.filter(
    (beat) => (beat.function === "WHAT" || beat.function === "HOW") && introduces(beat) && !beat.why?.fact_ids.length,
  );
  return verdict("Q-W2", "tagged", missing.map((beat) => beat.id));
}

function leadsWithWhy(chapter: ScriptChapter, lead: ScriptBeat | undefined): boolean {
  if (WHY_QUESTION.test(chapter.question)) return true;
  if (!lead) return false;
  return Boolean(lead.why?.fact_ids.length) || VALUE_MARKER.test(firstSentence(lead.spoken));
}

/** Q-W3 reads the chapter's first body beat: a cited `why`, a why or value opening, or a why-question chapter. */
export function whyBeforeHow(script: ScriptV1): L0Result {
  const late = bodyChapters(script).flatMap((chapter) => {
    const lead = firstBodyBeat(beatsOf(script, chapter));
    return leadsWithWhy(chapter, lead) ? [] : [lead?.id ?? chapter.id];
  });
  return verdict("Q-W3", "heuristic", late);
}

function userValuePerChapter(script: ScriptV1): L0Result {
  const missing = bodyChapters(script).flatMap((chapter) => {
    const beats = beatsOf(script, chapter);
    return beats.some((beat) => beat.user_value?.fact_ids.length) ? [] : [firstBodyBeat(beats)?.id ?? chapter.id];
  });
  return verdict("Q-W4", "tagged", missing);
}

function promiseShape(script: ScriptV1): L0Result {
  const promise = script.video.promise;
  const scriptFailure = isTodo(promise) || !/\byou\b\s+\w+/i.test(promise) || /\btour of\b/i.test(promise) || CHAPTER_COUNT.test(promise);
  const beats = script.beats.filter((beat) => beat.function === "PROMISE" && (/\btour of\b/i.test(beat.spoken) || CHAPTER_COUNT.test(beat.spoken)));
  return verdict("Q-W5", "tagged", beats.map((beat) => beat.id), scriptFailure ? 1 : 0);
}

function invariantPerHow(script: ScriptV1): L0Result {
  const invariants = (script.video.invariants ?? []).map(norm);
  const speaksOne = (beat: ScriptBeat) => ABSENCE.test(beat.spoken) || invariants.some((inv) => norm(beat.spoken).includes(inv));
  const missing = howChapters(script).flatMap((chapter) => {
    const beats = beatsOf(script, chapter);
    return beats.some(speaksOne) ? [] : [beats.find((beat) => beat.function === "HOW")?.id ?? chapter.id];
  });
  return verdict("Q-W6", "heuristic", missing);
}

/** The most invariants a script may declare; the parser no longer caps them, so a spike script still loads. */
export const MAX_INVARIANTS = 2;

function invariantCap(script: ScriptV1): L0Result {
  const count = script.video.invariants?.length ?? 0;
  return { check_id: "Q-W6:invariant-cap", mode: "tagged", severity: "warning", value: count, threshold: MAX_INVARIANTS, pass: count <= MAX_INVARIANTS, detail_beats: [] };
}

/** L0 half of Q-W8: a fence exists and is drawn as a design. Whether each deep dive has one is the judge's half. */
function fenceAsDesign(script: ScriptV1): L0Result {
  const fences = script.beats.filter((beat) => beat.function === "FENCE");
  const undrawn = fences.filter((beat) => beat.visual.job !== "alternatives-vs-ours");
  return verdict("Q-W8", "tagged", undrawn.map((beat) => beat.id), fences.length ? 0 : 1);
}

/** L0 half of Q-W9: the sha is well formed. Whether the commit exists needs the pinned clone. */
function historyCitesSha(script: ScriptV1): L0Result {
  const bad = script.beats.filter((beat) => {
    if (beat.design_history) return !SHA.test(beat.design_history.source_sha);
    return beat.function === "HISTORY";
  });
  return verdict("Q-W9", "tagged", bad.map((beat) => beat.id));
}

function qualityGoalPerHow(script: ScriptV1): L0Result {
  const goals = script.video.quality_goals;
  if (!goals?.length) return verdict("Q-W10", "tagged", []);
  const named = (text: string) => goals.some((goal) => norm(text).includes(norm(goal.goal)));
  const missing = howChapters(script).flatMap((chapter) => {
    const texts = [chapter.label, chapter.question, chapter.concept ?? "", ...beatsOf(script, chapter).map((beat) => beat.spoken)];
    return texts.some(named) ? [] : [chapter.id];
  });
  return verdict("Q-W10", "tagged", missing);
}

function walksAnchor(beat: ScriptBeat, anchor: string): boolean {
  const { assertion, labels, chips, code } = beat.visual;
  const texts = [beat.spoken, assertion, ...labels, ...chips.map((chip) => chip.text), code?.file ?? ""];
  return texts.some((text) => norm(text).includes(anchor));
}

/**
 * Q-F3 follows the authored anchor, not the hook's vocabulary. Words like "cite" or "lines" recur
 * in a script whose walk follows a different call from its hook, so shared tokens prove no thread.
 */
export function runningExampleThread(script: ScriptV1): L0Result {
  const example = script.video.running_example;
  const hooks = script.beats.filter((beat) => beat.function === "HOOK");
  const hows = script.beats.filter((beat) => beat.function === "HOW");
  if (isTodo(example)) return verdict("Q-F3", "tagged", [], 1);
  const anchor = norm(example.anchor);
  const strays = hows.filter((beat) => !walksAnchor(beat, anchor));
  const walked = hows.length > 0 && hows.length - strays.length >= hows.length * THREAD_SHARE;
  const hooked = hooks.some((beat) => walksAnchor(beat, anchor));
  return verdict("Q-F3", "tagged", walked ? [] : strays.map((beat) => beat.id), (hooked ? 0 : 1) + (hows.length ? 0 : 1));
}

function limitsBeforeClose(script: ScriptV1): L0Result {
  const firstClose = script.beats.findIndex((beat) => beat.function === "CLOSE");
  const caveats = script.beats.flatMap((beat, i) => (beat.function === "CAVEAT" ? [{ beat, i }] : []));
  const late = caveats.filter(({ i }) => firstClose >= 0 && i > firstClose).map(({ beat }) => beat.id);
  const unvoiced = script.video.simplifications.length === 0 || caveats.length === 0 ? 1 : 0;
  return verdict("Q-F12", "tagged", late, unvoiced);
}

/** L0 half of Q-F13: each demo beat shows between one and eight cued steps. One path is the judge's half. */
function demoSteps({ script, view }: L0Input): L0Result {
  const steps = new Map(view.map((beat) => [beat.id, beat.visual.state_changes.length]));
  const bad = script.beats.filter((beat) => {
    const n = steps.get(beat.id) ?? 0;
    return beat.mode === "demo" && (n === 0 || n > MAX_DEMO_STEPS);
  });
  return verdict("Q-F13", "tagged", bad.map((beat) => beat.id));
}

const SCRIPT_RULES = [
  stakeVoiced,
  whyForElements,
  whyBeforeHow,
  userValuePerChapter,
  promiseShape,
  invariantPerHow,
  fenceAsDesign,
  historyCitesSha,
  qualityGoalPerHow,
  runningExampleThread,
  limitsBeforeClose,
];

/** The why, value and thread rules (Q-W*, Q-F3, Q-F12, Q-F13), one row each. */
export const whyCheck: L0Check = (input) => [...SCRIPT_RULES.map((rule) => rule(input.script)), invariantCap(input.script), demoSteps(input)];
