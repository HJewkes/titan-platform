import type { L0Result } from "./eval-l0.js";
import { beatClaims, claimFindings, findingLine, type GatheredFact } from "./lint-claims.js";
import type { CoverageManifest } from "./lint-coverage.js";
import { boundaryLinks, connectiveShare, firstIdentifier, MAX_CONNECTIVE_SHARE, MIN_LINKED, MIN_PLAIN_SHARE, PIVOT_FORM, thesisDefects, type Overuse } from "./lint-flow.js";
import { ASSERTION_MAX_WORDS, assertionDefects, HEADLINE_CHARS_PER_LINE, HEADLINE_MAX_LINES, headlineLines, overlongHeadlines } from "./lint-headline.js";
import { unsettledHeteronyms } from "./lint-heteronyms.js";
import { spokenDigitsHint, spokenTokenHint } from "./lint-spoken-tokens.js";
import { ledgerHint } from "./lint-ledger.js";
import { THREAD_SHARE } from "./lint-why.js";
import { CONNECTORS, type ScriptV1 } from "./script-schema.js";
import type { SpineV1 } from "./spine-schema.js";
import { listed, namedBeats, percent, type Hint } from "./repair-hint.js";
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

function tallied({ counts, linked }: Overuse): string {
  const words = [...counts].sort((a, b) => b[1] - a[1]).map(([word, count]) => `${word} x${count}`);
  const others = linked - [...counts.values()].reduce((sum, count) => sum + count, 0);
  return others ? `${words.join(", ")}; ${others} by a reference or a shared word` : words.join(", ");
}

function overuseHint(overused: Overuse): string {
  const { word, count, linked, beats } = overused;
  return `connective variety fails at ${percent(connectiveShare(overused))} (at most ${percent(MAX_CONNECTIVE_SHARE)}): "${word}" opens ${count} of ${linked} linked beats, past the ${percent(MAX_CONNECTIVE_SHARE)} one connective may carry: ${beats.join(", ")} (connectives: ${tallied(overused)}). The check counts a beat's connector_in before its spoken words, so ${connectorEdits(overused).join(", ")}, or another connective that keeps the same logical link to the beat before; vary the connective, never drop the link`;
}

function linkHint(script: ScriptV1): string {
  const { ratio, unlinked, overused } = boundaryLinks(script.beats);
  const rate = `${percent(ratio)} of in-chapter boundaries link (needs ${percent(MIN_LINKED)})`;
  const parts = [ratio >= MIN_LINKED ? `link rate passes: ${rate}` : `link rate fails: ${rate}; unlinked: ${listed(unlinked)}; open each on a connective, a "this" or "that" back-reference, or a word the beat before ends on`];
  parts.push(overused ? overuseHint(overused) : "connective variety passes");
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
    unsettledHeteronyms(beat.spoken).map(({ word, readings, position }) => `${beat.id} "${word}" (${position === undefined ? "" : `word ${position}; `}write ${declarations(word, readings)})`),
  );
  return `undeclared heteronyms: ${words.join("; ")}. Replace each bare word with the declaration of the reading its sentence means`;
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

function assertionHint(script: ScriptV1, row: L0Result): string {
  const named = namedBeats(script, row).map((beat) => `${beat.id} "${beat.visual.assertion}" (${assertionDefects(beat).join(", ")})`);
  return `headlines that do not assert: ${named.join("; ")}. Write each as one claim with a subject and a verb in at most ${ASSERTION_MAX_WORDS} words, such as "The desk refuses unknown parcels" rather than "Parcel refusal", and write it before the narration`;
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
  "Q-D7": assertionHint,
  "Q-E17": (script, row, _facts, spine) => (spine ? ledgerHint(script, row.detail_beats, spine) : undefined),
  "Q-E20": claimsHint,
  "map:hand-framing": (_script, row) =>
    `${listed(row.detail_beats)} draw a hand-made map (visual.layout_source "hand") with no "our-framing" chip; add the "our-framing" chip to each, since the viewer must know the map is our framing and not the code graph`,
};

/** The check ids with a repair hint of their own. */
export const HINTED_CHECKS: ReadonlySet<string> = new Set(Object.keys(HINTS));

const tokensOf = (text: string): Set<string> => new Set(text.split(/[\s,;:()"']+/).map((token) => token.replace(/\.$/, "")));

// A hint that re-reads the script can miss every beat the row names; the repair still needs to know where to look.
function namingRowBeats(found: string, row: L0Result): string | undefined {
  const tokens = tokensOf(found);
  if (!row.detail_beats.length || row.detail_beats.some((id) => tokens.has(id))) return found || undefined;
  return found ? `${found}; failing beats: ${listed(row.detail_beats)}` : `failing beats: ${listed(row.detail_beats)}`;
}

/** What a failing row measured, in words a repair can act on, naming every beat or item the row names. */
export function repairHint(row: L0Result, script: ScriptV1, facts?: readonly GatheredFact[], spine?: SpineV1, coverage?: CoverageManifest): string | undefined {
  const hint = HINTS[row.check_id];
  return hint ? namingRowBeats(hint(script, row, facts, spine, coverage)?.trim() ?? "", row) : undefined;
}
