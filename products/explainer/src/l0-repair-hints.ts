import type { L0Result } from "./eval-l0.js";
import { beatClaims, claimFindings, findingLine, type GatheredFact } from "./lint-claims.js";
import type { CoverageManifest } from "./lint-coverage.js";
import { boundaryLinks, firstIdentifier, MAX_CONNECTIVE_SHARE, MIN_LINKED, MIN_PLAIN_SHARE, PIVOT_FORM, thesisDefects, type Overuse } from "./lint-flow.js";
import { HEADLINE_CHARS_PER_LINE, HEADLINE_MAX_LINES, headlineLines, overlongHeadlines } from "./lint-headline.js";
import { unsettledHeteronyms } from "./lint-heteronyms.js";
import { spokenDigitsHint, spokenTokenHint } from "./lint-spoken-tokens.js";
import { ledgerHint } from "./lint-ledger.js";
import { THREAD_SHARE } from "./lint-why.js";
import { CONNECTORS, type ScriptV1 } from "./script-schema.js";
import type { SpineV1 } from "./spine-schema.js";
import { listed, percent, type Hint } from "./repair-hint.js";
import { COVERAGE_HINTS } from "./repair-hints-coverage.js";
import { FLOW_HINTS } from "./repair-hints-flow.js";
import { VOICE_HINTS } from "./repair-hints-voice.js";
import { WHY_HINTS } from "./repair-hints-why.js";

// The beats past the cap each get the least-used connector the cap still allows; with none left, a shared word links.
function connectorEdits({ word, linked, beats, counts }: Overuse): string[] {
  const cap = Math.floor(MAX_CONNECTIVE_SHARE * linked);
  const tally = new Map(CONNECTORS.filter((c) => c !== word).map((c) => [c, counts.get(c) ?? 0]));
  return beats.slice(cap).map((id) => {
    const least = [...tally].sort((a, b) => a[1] - b[1])[0];
    if (!least || least[1] >= cap) return `on ${id} remove connector_in and open on a word the beat before ends on`;
    const [pick, used] = least;
    tally.set(pick, used + 1);
    return `set connector_in to "${pick}" on ${id}`;
  });
}

function overuseHint(overused: Overuse): string {
  const { word, count, linked, beats } = overused;
  return `"${word}" opens ${count} of ${linked} linked beats, past the ${percent(MAX_CONNECTIVE_SHARE)} one connective may carry: ${beats.join(", ")}. The check counts a beat's connector_in before its spoken words, so ${connectorEdits(overused).join(", ")}`;
}

function linkHint(script: ScriptV1): string {
  const { ratio, unlinked, overused } = boundaryLinks(script.beats);
  const parts = [`${percent(ratio)} of in-chapter boundaries link (needs ${percent(MIN_LINKED)}); unlinked: ${listed(unlinked)}`];
  if (overused) parts.push(overuseHint(overused));
  return parts.join("; ");
}

function threadHint(script: ScriptV1, row: L0Result): string | undefined {
  const example = script.video.running_example;
  if (typeof example === "string") return undefined;
  return `running_example.anchor "${example.anchor}" must appear as written in a HOOK beat and in ${percent(THREAD_SHARE)} of HOW beats (spoken, assertion, a label, a chip or the code file); HOW beats without it: ${listed(row.detail_beats)}`;
}

const declarations = (word: string, readings: readonly string[]): string =>
  readings.length ? readings.map((reading) => `[${word}](=${reading})`).join(" or ") : `a [${word}](/phonemes/) override`;

function heteronymHint(script: ScriptV1): string {
  const words = script.beats.flatMap((beat) =>
    unsettledHeteronyms(beat.spoken).map(({ word, readings }) => `${beat.id} "${word}" (write ${declarations(word, readings)})`),
  );
  return `undeclared heteronyms: ${words.join("; ")}`;
}

function plainOpeningHint(script: ScriptV1): string | undefined {
  const first = firstIdentifier(script.beats);
  if (!first) return undefined;
  return `the first identifier the voice says is "${first.word}" in ${first.beat}, after ${percent(first.share)} of the words (needs ${percent(MIN_PLAIN_SHARE)}); say it in plain words there, or name it later`;
}

function headlineHint(script: ScriptV1): string {
  const named = overlongHeadlines(script.beats).map((beat) => `${beat.id} "${beat.visual.assertion}" (${headlineLines(beat.visual.assertion)} lines)`);
  return `headlines past the band: ${named.join("; ")}. The band shows ${HEADLINE_MAX_LINES} lines of about ${HEADLINE_CHARS_PER_LINE} characters; shorten each to fit`;
}

// With the facts at hand each claim is named with the fact that came closest; without them, each failing beat's claims.
function claimsHint(script: ScriptV1, row: L0Result, facts?: readonly GatheredFact[]): string {
  const failing = new Set(row.detail_beats);
  const quoted = () => script.beats
    .filter((beat) => failing.has(beat.id))
    .map((beat) => `${beat.id}: ${beatClaims(beat).map((claim) => `"${claim.text}"`).join(", ")}`);
  const named = facts?.length ? claimFindings(script, facts).map(findingLine) : quoted();
  return `claims the gathered facts do not back are among ${named.join("; ")}. Name only pull requests and tasks the facts hold, and make each count equal a cited fact's value or the number of cited facts it counts; cite the facts in fact_ids, or drop the number`;
}

const HINTS: Readonly<Record<string, Hint>> = {
  ...WHY_HINTS,
  ...VOICE_HINTS,
  ...FLOW_HINTS,
  ...COVERAGE_HINTS,
  "Q-F1": linkHint,
  "Q-F3": threadHint,
  "Q-F4": (script) => thesisDefects(script).join("; "),
  "Q-F5": (_script, row) => `the check counts sentences shaped as ${PIVOT_FORM}; this draft has ${row.value} (${listed(row.detail_beats)}) and needs exactly one, where WHAT turns to HOW`,
  "Q-F16": plainOpeningHint,
  "Q-V10": heteronymHint,
  "Q-V12": spokenDigitsHint,
  "Q-V13": headlineHint,
  "Q-V14": spokenTokenHint,
  "Q-E17": (script, row, _facts, spine) => (spine ? ledgerHint(script, row.detail_beats, spine) : undefined),
  "Q-E20": claimsHint,
};

/** The check ids with a repair hint of their own. */
export const HINTED_CHECKS: ReadonlySet<string> = new Set(Object.keys(HINTS));

/** What a failing row measured, in words a repair can act on, for the rows whose value and beats alone say too little. */
export const repairHint = (row: L0Result, script: ScriptV1, facts?: readonly GatheredFact[], spine?: SpineV1, coverage?: CoverageManifest): string | undefined =>
  HINTS[row.check_id]?.(script, row, facts, spine, coverage);
