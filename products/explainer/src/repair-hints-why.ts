import { MAX_DEMO_STEPS, STAKE_BY_SHARE, stakeFunctions } from "./lint-why.js";
import { startShares } from "./lint-text.js";
import { listed, namedBeats, namedChapters, percent, quoted, type Hint } from "./repair-hint.js";
import type { ScriptV1 } from "./script-schema.js";

const isTodo = (value: unknown): value is string => typeof value === "string" && value.startsWith("TODO:");
const ABSENCE_WORDS = "never, always, every, nothing, cannot or only";

/** Q-W1: name the early stake-carrying beats and the two things one of them must say together. */
function stakeHint(script: ScriptV1): string {
  const stake = script.video.stake;
  if (isTodo(stake)) return `video.stake is still "${stake}"; fill who, loses_what, number and fact_ids`;
  const carriers = stakeFunctions(script.structure);
  const shares = startShares(script.beats);
  const early = script.beats.filter((b) => carriers.includes(b.function) && (shares.get(b.id) ?? 1) < STAKE_BY_SHARE);
  const kinds = carriers.join(" or ");
  if (early.length === 0) return `no ${kinds} beat starts before ${percent(STAKE_BY_SHARE)} of planned time; move one earlier, or shorten the beats before it`;
  const named = early.map((b) => `${b.id} (${b.function}, at ${percent(shares.get(b.id) ?? 0)})`).join(", ");
  return `the ${kinds} beats that start before ${percent(STAKE_BY_SHARE)} are ${named}, and none says "you" (or "${stake.who}") together with a number in its spoken words. In ${early[0]!.id}, say "you" and the stake's number "${stake.number}" in one sentence`;
}

function whyForTermsHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const named = namedBeats(script, row).map((b) => `${b.id} (new_terms ${quoted(b.new_terms)})`);
  return `${named.join("; ")} introduce names with no why.fact_ids; give each a why { need, actor, consequence, fact_ids } that cites a fact, or move the new names to a beat that has one`;
}

function promiseHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const parts = row.value > row.detail_beats.length ? [`video.promise "${script.video.promise}" must say "you" and a verb (you'll know, you can tell), with no "tour of" and no chapter count`] : [];
  if (row.detail_beats.length) parts.push(`PROMISE beats ${listed(row.detail_beats)} say "tour of" or a chapter count; drop it`);
  return parts.join("; ");
}

function invariantHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const invariants = script.video.invariants ?? [];
  const named = invariants.length ? `one of video.invariants (${quoted(invariants)}) or ` : "";
  return `the HOW chapters ${listed(namedChapters(script, row))} never speak an invariant; in one beat of each, say ${named}an absence word (${ABSENCE_WORDS}) about how the project behaves`;
}

function fenceHint(_script: ScriptV1, row: Parameters<Hint>[1]): string {
  const missing = row.value > row.detail_beats.length ? ["the script has no FENCE beat; add one that shows the alternative and ours, with visual.job \"alternatives-vs-ours\""] : [];
  const undrawn = row.detail_beats.length ? [`set visual.job to "alternatives-vs-ours" on ${listed(row.detail_beats)}`] : [];
  return [...missing, ...undrawn].join("; ");
}

function qualityGoalHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const goals = (script.video.quality_goals ?? []).map((g) => g.goal);
  return `chapters ${listed(row.detail_beats)} name no quality goal; say one of ${quoted(goals)} as written, in the chapter question or one of its beats`;
}

function limitsHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const parts = row.detail_beats.length ? [`move CAVEAT beats ${listed(row.detail_beats)} before the first CLOSE beat`] : [];
  if (row.value > row.detail_beats.length) {
    const missing = script.video.simplifications.length === 0 ? "video.simplifications is empty; add the one this video makes, and " : "";
    parts.push(`${missing}voice the simplification in a CAVEAT beat before the close`);
  }
  return parts.join("; ");
}

/** The why, value and thread rules: Q-W1 to Q-W10, Q-F12 and Q-F13. */
export const WHY_HINTS: Readonly<Record<string, Hint>> = {
  "Q-W1": stakeHint,
  "Q-W2": whyForTermsHint,
  "Q-W3": (script, row) =>
    `${listed(row.detail_beats)} open their chapter (${listed(namedChapters(script, row))}) with no why: give that beat why.fact_ids, open its first sentence on "so that", "which means", "lets you" or "so you", or make the chapter question start with "Why" or "How come"`,
  "Q-W4": (script, row) =>
    `chapters ${listed(namedChapters(script, row))} have no beat with user_value.fact_ids; add user_value { text, fact_ids } to ${listed(row.detail_beats)}, citing a fact that shows the value`,
  "Q-W5": promiseHint,
  "Q-W6": invariantHint,
  "Q-W8": fenceHint,
  "Q-W9": (_script, row) =>
    `${listed(row.detail_beats)}: a HISTORY beat needs design_history, and its source_sha must be a 7-40 character hex commit sha the facts hold`,
  "Q-W10": qualityGoalHint,
  "Q-F12": limitsHint,
  "Q-F13": (_script, row) => `demo beats ${listed(row.detail_beats)} need 1 to ${MAX_DEMO_STEPS} cued steps each; add a cue per step, or split the demo`,
};
