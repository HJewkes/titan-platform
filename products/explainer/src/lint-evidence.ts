import type { L0Check, L0Result } from "./eval-l0.js";
import { beatsOf, verdict } from "./lint-why.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

export const MAX_NEW_NAMES_PER_CHAPTER = 4;
/** The profile that must carry no verdicts (Q-E3). */
export const PUBLIC_PROFILE = "repo-tour-public";

const CLAIM_FUNCTIONS = new Set<ScriptBeat["function"]>(["STAKE", "MISCONCEPTION", "WHAT", "HOW", "FENCE", "HISTORY", "CAVEAT", "VERDICT"]);
const SOURCED_CHIPS = new Set<ScriptBeat["visual"]["chips"][number]["kind"]>(["verified", "computed"]);

/** L0 half of Q-E1: every claim beat and every verified or computed chip names a fact. Status needs the facts pack. */
function claimsCiteFacts(script: ScriptV1): L0Result {
  const uncited = script.beats.filter(
    (beat) =>
      (CLAIM_FUNCTIONS.has(beat.function) && beat.fact_ids.length === 0) ||
      beat.visual.chips.some((chip) => SOURCED_CHIPS.has(chip.kind) && !chip.fact_id),
  );
  return verdict("Q-E1", "tagged", uncited.map((beat) => beat.id));
}

/** L0 half of Q-E2: the running example is authored and cites a fact a journey test can check. */
function runningExampleSourced(script: ScriptV1): L0Result {
  const example = script.video.running_example;
  const sourced = typeof example !== "string" && example.fact_ids.length > 0;
  return verdict("Q-E2", "tagged", [], sourced ? 0 : 1);
}

/** Per-script half of Q-E3: a public-profile script has no VERDICT beat. */
function publicProfileHasNoVerdicts(script: ScriptV1): L0Result {
  const verdicts = script.profile === PUBLIC_PROFILE ? script.beats.filter((beat) => beat.function === "VERDICT") : [];
  return verdict("Q-E3", "tagged", verdicts.map((beat) => beat.id));
}

function termsInGlossary(script: ScriptV1): L0Result {
  const glossary = new Set(script.video.glossary.map((entry) => entry.name.toLowerCase()));
  const unglossed = script.beats.filter((beat) => beat.new_terms.some((term) => !glossary.has(term.toLowerCase())));
  const crowded = script.chapters.flatMap((chapter) => {
    const naming = beatsOf(script, chapter).filter((beat) => beat.new_terms.length > 0);
    const names = new Set(naming.flatMap((beat) => beat.new_terms.map((term) => term.toLowerCase())));
    return names.size > MAX_NEW_NAMES_PER_CHAPTER ? naming : [];
  });
  return verdict("Q-E4", "tagged", [...new Set([...unglossed, ...crowded].map((beat) => beat.id))]);
}

/** The evidence rules (Q-E1–Q-E4), one row each. */
export const evidenceCheck: L0Check = ({ script }) => [
  claimsCiteFacts(script),
  runningExampleSourced(script),
  publicProfileHasNoVerdicts(script),
  termsInGlossary(script),
];
