import { loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import type { LeadBeat } from "./lead-beats.js";
import { loadProfiles, profileFor } from "./profile-load.js";
import type { TypeProfile } from "./profile-schema.js";
import { resolveBeat, type ResolvedBeat } from "./resolve-beat.js";
import { overBudget, scriptBudgets, type BudgetRow } from "./resolve-budget.js";
import type { ScriptV1 } from "./script-schema.js";
import { loadSpeechBands } from "./speech-bands.js";
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

/** The word budgets resolve will hold the draft to, from the same function resolve calls. */
export function draftBudgets(draft: Draft): BudgetRow[] {
  const specs = loadBeatSpecs();
  return scriptBudgets(draft, resolvedBands(draft, specs), specs).rows;
}

/** The planned seconds a beat's words need at its slot's rate. */
const secondsFor = (row: BudgetRow): number => Math.ceil(row.words / row.wordsPerS);

const overText = (row: BudgetRow): string =>
  `${row.scope === "block" ? "block " : ""}${row.id} ${row.words}/${row.cap} words (${row.seconds} s at ${row.wordsPerS} w/s; ${row.words} words need ${secondsFor(row)} s)`;

/** One line per beat or block over its cap, naming words/cap. */
const wordBudgetFaults = (draft: Draft): string[] => overBudget(draftBudgets(draft)).map(overText);

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

/** Everything the plan check fails the draft on: each over-budget beat or block, then the runtime. */
export function planFaults(draft: Draft): string[] {
  const runtime = draftRuntime(draft);
  return [...wordBudgetFaults(draft), ...(runtime.pass ? [] : [`runtime: ${runtime.detail}`])];
}

/**
 * The retry's hint. The fix is more plannedS, not fewer words: measured drafts sat under the runtime floor with every
 * beat over its cap, so cutting words would only widen the runtime gap. Seconds the words do not fill are dead air,
 * which the pace and stage-empty checks fail, so the words grow with the slot.
 */
export const planHint = (faults: readonly string[]): string =>
  `The plan check failed:\n${faults.map((fault) => `- ${fault}`).join("\n")}\n\nRaise each beat's plannedS until its words fit under its cap and the beats sum to the profile's target runtime, then write each beat's spoken text close to its new cap, so no slot is left silent.`;

const capLine = ({ chapter, spec }: LeadBeat, wordsPerS: number): string =>
  `- ${chapter} (${spec.type}, ${spec.speech.band} band): at most plannedS × ${wordsPerS} words, rounded down`;

/** The prompt's word caps and runtime: each lead beat's rate, the band table for the rest, and the profile's runtime. */
export function budgetSection(leads: readonly LeadBeat[], profile: string): string {
  const bands = loadSpeechBands();
  const table = Object.entries(bands).map(([band, { wordsPerS }]) => `${band} ${wordsPerS}`).join(", ");
  const lines = leads.map((lead) => capLine(lead, bands[lead.spec.speech.band].wordsPerS));
  const { runtime } = profileFor(loadProfiles(), profile);
  return `## Word caps and runtime

The beats' plannedS sum to about ${runtime.targetS} s, and never below ${runtime.minS} s or above ${runtime.maxS} s. A beat speaks at most plannedS times its beat spec's words per second, rounded down, and close to that cap, since seconds the words do not fill are silent. Words per second by speech band: ${table}.
${lines.join("\n")}`;
}
