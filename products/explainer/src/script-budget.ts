import { loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import type { LeadBeat } from "./lead-beats.js";
import { BEAT_SECONDS } from "./lint-flow.js";
import { bodyBeats } from "./lint-text.js";
import { loadProfiles, profileFor, type ProfileSet } from "./profile-load.js";
import type { TypeProfile } from "./profile-schema.js";
import { resolveBeat, type ResolvedBeat } from "./resolve-beat.js";
import { overBudget, scriptBudgets, type BudgetRow } from "./resolve-budget.js";
import type { ScriptV1 } from "./script-schema.js";
import { loadSpeechBands } from "./speech-bands.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { shippedVisualRouter } from "./visual-router.js";

type Draft = Pick<ScriptV1, "beats" | "profile">;

/** The bands resolve will hold each beat to; a beat the resolver refuses has none, and resolve refuses it on its own. */
function resolvedBands(draft: Draft, specs: ReadonlyMap<string, BeatSpec>): Pick<ResolvedBeat, "id" | "band">[] {
  const router = shippedVisualRouter();
  return draft.beats.flatMap((beat) => {
    const found = resolveBeat(beat, specs, router);
    return "code" in found ? [] : [found];
  });
}

/**
 * The word budgets resolve will hold the draft to, from the same function resolve calls. Counted on the voiced draft:
 * rewrite spells every number before resolve reads the script, and "$2.55" is one token but several spoken words.
 */
export function draftBudgets(draft: Draft): BudgetRow[] {
  const specs = loadBeatSpecs();
  const voiced = { ...draft, beats: draft.beats.map(spellSpokenNumbers) };
  return scriptBudgets(voiced, resolvedBands(voiced, specs), specs).rows;
}

/** The planned seconds a beat's words need at its slot's rate. */
const secondsFor = (row: BudgetRow): number => Math.ceil(row.words / row.wordsPerS);

const overText = (row: BudgetRow): string =>
  `${row.scope === "block" ? "block " : ""}${row.id} ${row.words}/${row.cap} words (${row.seconds} s at ${row.wordsPerS} w/s; ${row.words} words need ${secondsFor(row)} s)`;

/** One line per beat or block over its cap, naming words/cap. */
export const wordBudgetFaults = (draft: Draft): string[] => overBudget(draftBudgets(draft)).map(overText);

const plannedTotal = (draft: Draft): number => draft.beats.reduce((sum, beat) => sum + beat.plannedS, 0);

const runtimeText = ({ type, runtime }: TypeProfile): string => `${type} runs ${runtime.minS}-${runtime.maxS} s, target ${runtime.targetS} s`;

const cutText = (cut: TypeProfile["cuts"][number]): string => `, or ${cut.runtimeS[0]}-${cut.runtimeS[1]} s as cut ${cut.id}`;

/**
 * The draft's summed plannedS against the profile's [minS, maxS]. A profile cut's band also passes: the script stage
 * is not told which cut a run is (pr-overview's decision brief runs 45-90 s, under the profile's floor).
 */
export function draftRuntime(draft: Draft): { pass: boolean; detail: string } {
  const profile = profileFor(loadProfiles(), draft.profile);
  const total = plannedTotal(draft);
  const bands: [number, number][] = [[profile.runtime.minS, profile.runtime.maxS], ...profile.cuts.map((cut) => cut.runtimeS)];
  const pass = bands.some(([min, max]) => total >= min && total <= max);
  return { pass, detail: `the beats plan ${total} s; ${runtimeText(profile)}${profile.cuts.map(cutText).join("")}` };
}

/** The draft's word budgets as a gate verdict: each beat or block over its cap, as words/cap. */
export function draftWordBudget(draft: Draft): { pass: boolean; detail: string } {
  const faults = wordBudgetFaults(draft);
  return { pass: faults.length === 0, detail: faults.length === 0 ? "every beat and block within its cap" : `over: ${faults.join("; ")}` };
}

const [MIN_BEAT_S, MAX_BEAT_S] = BEAT_SECONDS;

/** The fewest beats a chapter of `chapterS` seconds splits into, each within Q-F8's longest beat. */
export const beatsFor = (chapterS: number): number => Math.max(1, Math.ceil(chapterS / MAX_BEAT_S));

const chapterSeconds = (draft: Draft, chapter: string): number =>
  draft.beats.filter((beat) => beat.chapter === chapter).reduce((sum, beat) => sum + beat.plannedS, 0);

function beatLengthText(draft: Draft, { id, chapter, plannedS }: Draft["beats"][number]): string {
  const band = `${id} (${chapter}) plans ${plannedS} s; a beat runs ${MIN_BEAT_S}-${MAX_BEAT_S} s`;
  if (plannedS < MIN_BEAT_S) return `${band}, so lengthen it or merge it into a neighbour`;
  const seconds = chapterSeconds(draft, chapter);
  return `${band}, so ${chapter}'s ${seconds} s splits into at least ${beatsFor(seconds)} beats`;
}

/** One line per beat Q-F8 holds to its seconds band (the close and chapter-open questions are exempt) and outside it. */
const beatLengthFaults = (draft: Draft): string[] =>
  bodyBeats(draft.beats)
    .filter((beat) => beat.plannedS < MIN_BEAT_S || beat.plannedS > MAX_BEAT_S)
    .map((beat) => beatLengthText(draft, beat));

/** The draft's beat lengths as a gate verdict, so the plan retry splits a long beat before L0's Q-F8 fails it. */
export function draftBeatLengths(draft: Draft): { pass: boolean; detail: string } {
  const faults = beatLengthFaults(draft);
  return { pass: faults.length === 0, detail: faults.length === 0 ? `every beat within ${MIN_BEAT_S}-${MAX_BEAT_S} s` : `out of band: ${faults.join("; ")}` };
}

/** Everything the plan check fails the draft on: each over-budget beat or block, each beat out of Q-F8's band, then the runtime. */
export function planFaults(draft: Draft): string[] {
  const runtime = draftRuntime(draft);
  return [...wordBudgetFaults(draft), ...beatLengthFaults(draft).map((fault) => `beat length: ${fault}`), ...(runtime.pass ? [] : [`runtime: ${runtime.detail}`])];
}

/**
 * The retry's hint. The fix is more plannedS, not fewer words: measured drafts sat under the runtime floor with every
 * beat over its cap, so cutting words would only widen the runtime gap. Seconds the words do not fill are dead air,
 * which the pace and stage-empty checks fail, so the words grow with the slot. Raising plannedS alone left one
 * 35-45 s beat per chapter, which Q-F8 fails, so the seconds go to more beats, not longer ones.
 */
export const planHint = (faults: readonly string[]): string =>
  `The plan check failed:\n${faults.map((fault) => `- ${fault}`).join("\n")}\n\nRaise plannedS until each beat's words fit under its cap and the beats sum to the profile's target runtime, but keep every beat other than the close within ${MIN_BEAT_S}-${MAX_BEAT_S} s: split a longer beat into continuation beats in the same chapter, one idea each. Then write each beat's spoken text close to its new cap, so no slot is left silent.`;

const capLine = ({ chapter, spec }: LeadBeat, wordsPerS: number): string =>
  `- ${chapter} (${spec.type}, ${spec.speech.band} band): at most plannedS × ${wordsPerS} words, rounded down, counting each number as the words the voice reads`;

/**
 * Each lead's share of the target. A fixed profile's chapters are its macro's blocks in order, so they take the
 * structure's block shares and a long block gets more beats than the ask; any other plan splits the target evenly.
 */
function chapterShares(leads: readonly LeadBeat[], set: ProfileSet, profile: TypeProfile): number[] {
  const even = leads.map(() => 1 / leads.length);
  const { structure } = profile;
  if (structure.order !== "fixed" || leads.length !== structure.blocks.length) return even;
  const shares = new Map(set.structures.get(structure.macro)?.blocks.map((block) => [block.id, block.share]));
  const weights = structure.blocks.map((block) => shares.get(block.id));
  if (weights.some((weight) => weight === undefined)) return even;
  const sum = weights.reduce((total: number, weight) => total + weight!, 0);
  return weights.map((weight) => weight! / sum);
}

/** The prompt's beat plan: Q-F8's band, each chapter's fewest beats at its share of the target, and the lead-beat split. */
function beatPlan(leads: readonly LeadBeat[], targetS: number, shares: readonly number[]): string {
  const seconds = leads.map((_, i) => targetS * shares[i]!);
  const counts = leads.map(({ chapter }, i) => `${chapter} ${beatsFor(seconds[i]!)} (${Math.round(seconds[i]!)} s)`).join(", ");
  const total = Math.max(beatsFor(targetS), seconds.reduce((sum, chapterS) => sum + beatsFor(chapterS), 0));
  const split = counts ? ` At each chapter's share of the target that is at least: ${counts}.` : "";
  return `One idea per beat: every beat but the close plans ${MIN_BEAT_S}-${MAX_BEAT_S} s, so a chapter of chapterS seconds holds ceil(chapterS / ${MAX_BEAT_S}) beats or more.${split} Plan at least ${total} beats in all. A chapter's first beat carries its lead beat spec; each later beat in the chapter is a continuation beat with its own id, one function, its own plannedS and its own cues, and keeps the chapter's "visual.beat", listing in "visual.labels" only the items it adds.`;
}

/** The profile's label conventions, one line per block that has them, so the host bridge's views fire on the labels written. */
function labelRules(profile: TypeProfile): string {
  const rows = profile.structure.blocks.flatMap((block) => (block.labels ? [`- ${block.id}: ${block.labels}`] : []));
  return rows.length > 0 ? `\n\nWrite "visual.labels" by the chapter's convention; the host draws a view only when the labels follow it:\n${rows.join("\n")}` : "";
}

/** The prompt's word caps, runtime and beat plan: each lead beat's rate, the band table for the rest, and the profile's runtime. */
export function budgetSection(leads: readonly LeadBeat[], profile: string): string {
  const bands = loadSpeechBands();
  const table = Object.entries(bands).map(([band, { wordsPerS }]) => `${band} ${wordsPerS}`).join(", ");
  const lines = leads.map((lead) => capLine(lead, bands[lead.spec.speech.band].wordsPerS));
  const set = loadProfiles();
  const type = profileFor(set, profile);
  const { runtime } = type;
  return `## Word caps, runtime and beats

The beats' plannedS sum to about ${runtime.targetS} s, and never below ${runtime.minS} s or above ${runtime.maxS} s. ${beatPlan(leads, runtime.targetS, chapterShares(leads, set, type))} A beat speaks at most plannedS times its beat spec's words per second, rounded down, and close to that cap, since seconds the words do not fill are silent. Words per second by speech band: ${table}.
${lines.join("\n")}${labelRules(type)}`;
}
