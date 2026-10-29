import { loadBeatSpecs } from "./beat-load.js";
import type { BeatSpec } from "./beat-schema.js";
import type { L0Check } from "./eval-l0.js";
import { bodyBeats, countRow, ruleRow } from "./lint-text.js";
import { loadProfiles, profileFor, type ProfileSet } from "./profile-load.js";
import { timingProfile, type TimingProfile } from "./qa/timing-gates.js";
import { beatBudget, type BudgetRow } from "./resolve-budget.js";
import { resolveBeat } from "./resolve-beat.js";
import { beatCues, spokenWordIndex, type ScriptBeat, type ScriptV1 } from "./script-schema.js";
import { loadSpeechBands, type SpeechBands } from "./speech-bands.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { shippedVisualRouter } from "./visual-router.js";

/**
 * Script-time preflight for qa's timing rows (TP-4470): planned cue gaps against picture-change, the held-beat count
 * against G12, and a fill floor so the beats' words, not their tails, carry the runtime once truing trims a beat to
 * its speech.
 */

/** A body beat speaks at least this share of its word cap, so the trued beat keeps about its planned length. */
export const FILL_FLOOR = 0.8;

interface Doctrine {
  profiles: ProfileSet;
  specs: ReadonlyMap<string, BeatSpec>;
  bands: SpeechBands;
}

let shipped: Doctrine | undefined;
// Read once: the rewrite pass runs L0 once per candidate beat, and the doctrine never changes inside a process.
export const doctrine = (): Doctrine => (shipped ??= { profiles: loadProfiles(), specs: loadBeatSpecs(), bands: loadSpeechBands() });

/** The script's pacing, or undefined for a profile the doctrine does not hold (its runtime check says so on its own). */
export function scriptPacing(script: Pick<ScriptV1, "profile">): TimingProfile["pacing"] | undefined {
  const { profiles } = doctrine();
  return profiles.profiles.has(script.profile) ? timingProfile(profileFor(profiles, script.profile)).pacing : undefined;
}

/** The beat's voiced words against its cap at its beat type's band rate, numbers spelled as the voice reads them. */
function voicedBudget(beat: ScriptBeat): BudgetRow | undefined {
  const { specs, bands } = doctrine();
  const found = resolveBeat(beat, specs, shippedVisualRouter());
  return "code" in found ? undefined : beatBudget(spellSpokenNumbers(beat), found.band, bands);
}

/** The longest planned stretch with no cue: from the cut in, between cues, and to the end of the voiced words. */
export function longestCueGapS(beat: ScriptBeat): number | undefined {
  const budget = voicedBudget(beat);
  if (!budget) return undefined;
  const voiced = spellSpokenNumbers(beat);
  const index = spokenWordIndex(voiced);
  const endS = Math.min(beat.plannedS, budget.words / budget.wordsPerS);
  const cues = beatCues(voiced.visual).map((cue) => Math.min(endS, index(cue) / budget.wordsPerS));
  const times = [0, ...cues, endS].sort((a, b) => a - b);
  return Math.max(0, ...times.slice(1).map((t, i) => t - times[i]!));
}

const isHeld = (beat: ScriptBeat): boolean => beat.band === "held" || (beat.heldS ?? 0) > 0;

/** The beats the script declares held, by `heldS` or the held speech band, as qa's timing gates read them. */
export const heldBeats = (beats: readonly ScriptBeat[]): string[] => beats.filter(isHeld).map((beat) => beat.id);

/** Body beats whose voiced words fall under the fill floor of their cap; a held beat is quiet on purpose. */
export const underfilledBeats = (beats: readonly ScriptBeat[]): { beat: ScriptBeat; budget: BudgetRow }[] =>
  bodyBeats(beats).filter((beat) => !isHeld(beat)).flatMap((beat) => {
    const budget = voicedBudget(beat);
    return budget && budget.words < Math.ceil(FILL_FLOOR * budget.cap) ? [{ beat, budget }] : [];
  });

/** Q-D17: no planned stretch of a beat without a cue runs past the profile's `pacing.pictureChangeFailS`. */
export const cueGapCheck: L0Check = ({ script }) => {
  const pacing = scriptPacing(script);
  if (!pacing) return [];
  const over = script.beats.filter((beat) => (longestCueGapS(beat) ?? 0) > pacing.pictureChangeFailS).map((beat) => beat.id);
  return [countRow("Q-D17", over)];
};

/** Q-D18: the count of declared held beats sits within the profile's `pacing.held` band (qa's G12, at script time). */
export const heldCountCheck: L0Check = ({ script }) => {
  const pacing = scriptPacing(script);
  if (!pacing) return [];
  const [min, max] = pacing.held;
  const held = heldBeats(script.beats);
  return [ruleRow("Q-D18", { value: held.length, threshold: min, pass: held.length >= min && held.length <= max, beats: held.length > max ? held : [], mode: "tagged" })];
};

/** Q-D19: every body beat speaks at least the fill floor of its word cap. */
export const fillFloorCheck: L0Check = ({ script }) => [countRow("Q-D19", underfilledBeats(script.beats).map(({ beat }) => beat.id))];
