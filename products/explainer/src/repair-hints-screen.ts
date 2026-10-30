import { CLAIM_CARD, cuelessKind, FILL_FLOOR, heldBeats, longestCueGapS, scriptPacing, underfilledBeats, voicedBudget } from "./lint-cadence.js";
import { REFLECTION_CHAPTER } from "./lint-coverage.js";
import { BEAT_SECONDS } from "./lint-flow.js";
import { PACING_DEFAULTS } from "./qa/timing-gates.js";
import { bodyBeats } from "./lint-text.js";
import { FRAME_MAX_WORDS, frameCounts } from "./lint-frame-words.js";
import { HEADING_MAX_WORDS, LABEL_MAX_WORDS, overlongTexts, stillOpenings } from "./lint-direction.js";
import { ECHO_RUN_WORDS, echoedLabels, unspokenNumbers } from "./lint-screen.js";
import { drawnBeats, refusedBeats } from "./drawn-beats.js";
import { drawnTexts } from "./drawn-texts.js";
import { stillBeats, type StillStretch } from "./lint-still.js";
import { clipped, listed, namedBeats, quoted, type Hint } from "./repair-hint.js";
import { capClauses } from "./split-piece-rules.js";
import { beatCues, type ScriptBeat, type ScriptV1 } from "./script-schema.js";
import { spokenWords, type SpokenWord } from "./still-seed.js";

const seconds = (s: number): string => `${Math.round(s * 10) / 10} s`;

const numbersHint: Hint = (script, row) => {
  const named = namedBeats(script, row).map((beat) => `${beat.id} shows ${unspokenNumbers(script, beat).map(({ fact, shown }) => `"${fact}" (in "${clipped(shown)}")`).join(", ")}`);
  return `on-screen numbers the beat never says: ${named.join("; ")}. Say each number in that beat's spoken text, or drop it from the assertion, labels, chips or chapter label: say it or drop it`;
};

/** A refused beat draws nothing for the finders below; its own template-fill row names the fault to fix. */
const refusedNotes = (script: ScriptV1, row: Parameters<Hint>[1]): string[] =>
  refusedBeats(script).filter((beat) => row.detail_beats.includes(beat)).map((beat) => `${beat} (the template fill refuses it: answer its template-fill row)`);

const frameHint: Hint = (script, row) => {
  const failing = new Set(row.detail_beats);
  const named = [...refusedNotes(script, row), ...frameCounts(script).filter((count) => failing.has(count.beat)).map((count) => `${count.beat} (${count.words} words as ${count.kind})`)];
  return `beats whose fullest frame shows more than ${FRAME_MAX_WORDS} words, headline, rows and source line together: ${named.join(", ")}. Write rows as key words, not sentences, and move the rest to the narration`;
};

const echoHint: Hint = (script, row) => {
  const named = namedBeats(script, row).map((beat) => `${beat.id} ${quoted(echoedLabels(script, beat).map(clipped))}`);
  return `on-screen texts repeating ${ECHO_RUN_WORDS} or more spoken words in a row: ${named.join("; ")}. Keep the key words, not the sentence: the screen names it, the voice says it`;
};

const [BEAT_FLOOR_S] = BEAT_SECONDS;

// A claim-card's one cue target is its claim, which lights on a cue past its first word; any other cue-less kind takes none.
const CLAIM_CUE = 'cue its claim (target "claim") on a spoken word inside the stretch, past its first word, that names the claim\'s text, so the claim lights; ';
const cuelessLead = (beat: ScriptBeat, kind: string): string =>
  kind === CLAIM_CARD ? `${beat.id} is a ${kind} with no cue, and heldS does not excuse its stretch` : `${beat.id} is a ${kind}, which takes no cue, and heldS does not excuse its stretch`;

// heldS excuses no cue gap, so a cue-less kind's moves are its claim cue, a trim, a split or a cued kind.
function cuelessMove(beat: ScriptBeat, kind: string, failS: number): string {
  const budget = voicedBudget(beat);
  const lead = `${cuelessLead(beat, kind)}: ${kind === CLAIM_CARD ? CLAIM_CUE : ""}`;
  if (!budget) return `${lead}split it into ${kind} beats of at most ${failS} s of words each, or draw it as a list whose rows each land on a cue`;
  const cap = Math.floor(failS * budget.wordsPerS + 1e-9);
  const trim = `its spoken words must fit ${failS} s, at most ${cap} words (now ${budget.words}). Trim it to ${cap} words`;
  const pieces = Math.ceil(budget.words / cap);
  const list = "or draw it as a list whose rows each land on a cue";
  if (beat.plannedS / pieces < BEAT_FLOOR_S) return `${lead}${trim}, ${list}; a split would leave pieces under the ${BEAT_FLOOR_S} s beat floor`;
  return `${lead}${trim}, or split it into ${pieces} ${kind} beats of at most ${cap} words each, each still ${BEAT_FLOOR_S} s or longer by plannedS${splitKeeps(beat)}, ${list}`;
}

// A split must not lose the hold (Q-D18) or the slowdown fact a reflection answers (Q-E22).
export function splitKeeps(beat: ScriptBeat): string {
  const held = heldBeats([beat]).length > 0 ? "keep heldS on one piece only" : undefined;
  const slow = beat.chapter === REFLECTION_CHAPTER ? "cite the slow/ fact it answers in every piece" : undefined;
  const clauses = [held, slow].filter((clause) => clause !== undefined);
  return clauses.length === 0 ? "" : `; ${clauses.join(", and ")}`;
}

function cueGapHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const failS = scriptPacing(script)?.pictureChangeFailS ?? PACING_DEFAULTS.pictureChangeFailS;
  const beats = namedBeats(script, row);
  const named = beats.map((beat) => `${beat.id} (${seconds(longestCueGapS(beat) ?? beat.plannedS)}, ${beatCues(beat.visual).length} cues)`);
  const cueless = beats.flatMap((beat) => {
    const kind = cuelessKind(beat);
    return kind === undefined ? [] : [cuelessMove(beat, kind, failS)];
  });
  const fix = `Add a cue on a spoken word inside each long stretch, one per item the beat reveals, or split the beat so no stretch runs past ${failS} s`;
  return [`beats with a planned stretch of more than ${failS} s and no cue: ${named.join(", ")}. ${fix}`, ...cueless].join("; ");
}

// The words spoken inside a stretch are where its cue can go; the beat's texts are what that cue can point at.
function stretchText(words: readonly SpokenWord[], { fromS, toS, after }: StillStretch): string {
  const said = words.filter(({ s }) => s >= fromS && s <= toS).map(({ raw }) => raw);
  const voiced = said.length === 0 ? "" : `, saying "${clipped(said.join(" "))}"`;
  return `${seconds(fromS)} to ${seconds(toS)} ${after === undefined ? "from the cut" : `after "${after}"`} (${seconds(toS - fromS)}${voiced})`;
}

function onScreen(script: ScriptV1, beat: ScriptBeat): string {
  const drawn = drawnBeats(script).find(({ filled }) => filled.id === beat.id);
  // The chrome's headline and source line are no element a cue can point at.
  const texts = drawn ? (drawnTexts(drawn) ?? []).filter(({ cls }) => !cls.startsWith("xp-")).map(({ text }) => text) : beat.visual.labels;
  const shown = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  return shown.length === 0 ? "" : ` with ${quoted(shown.map(clipped))} on screen`;
}

const stillBeatText = (script: ScriptV1, { beat, stretches }: { beat: ScriptBeat; stretches: StillStretch[] }): string => {
  const words = spokenWords(beat);
  return `${beat.id} ${stretches.map((stretch) => stretchText(words, stretch)).join(", ")}${onScreen(script, beat)}`;
};

// A repair once met a still closing button by lengthening its label past Q-D20 and Q-D15, so every move that adds text
// names those caps, and a move that adds no words (a cue, a hold) comes first.
const WITHIN_CAPS = `within ${capClauses(["Q-D20", "Q-D15"])}`;

// A hold is offered only while the held band has room; once it is full, the next move that adds no hold leads.
function fullBand(script: ScriptV1): string | undefined {
  const max = (scriptPacing(script) ?? PACING_DEFAULTS).held[1];
  const held = heldBeats(script.beats);
  return held.length < max ? undefined : `the held band is full (${listed(held)} of at most ${max}), so it takes no hold`;
}

function cuelessStill(script: ScriptV1, beat: ScriptBeat, kind: string): string {
  const full = fullBand(script);
  const hold = full ?? "or hold it with heldS";
  const lead = kind === CLAIM_CARD ? `${beat.id} is a ${kind} with no cue: first, adding no words, ${CLAIM_CUE}${hold}` : `${beat.id} is a ${kind}, which reveals nothing on a cue: ${full ?? "first hold it with heldS, which adds no words"}`;
  const shown = kind === CLAIM_CARD ? "a claim" : "a line";
  return `${lead}; else show ${shown} the voice does not read word for word (its reading time is not still time) ${WITHIN_CAPS}, or draw it as a list whose rows each land on a cue, under the same Q-D20 and Q-D15 caps; trimming its words would break the fill floor`;
}

// A held beat is the one place static-window allows a still frame, so the hold is offered beside the cue and the split.
function stillHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const pacing = scriptPacing(script) ?? PACING_DEFAULTS;
  const { staticMaxS, held } = pacing;
  const failing = new Set(row.detail_beats);
  const found = stillBeats(script, pacing).filter(({ beat }) => failing.has(beat.id));
  const named = found.map((still) => stillBeatText(script, still));
  const fix = `Put a cue on a spoken word inside each stretch that names an on-screen element, on an item the beat reveals there; a cue on a word no element lands on moves nothing, and a kind reveals one element per item, so add the item ${WITHIN_CAPS}, or split the beat`;
  const cueless = found.flatMap(({ beat }) => {
    const kind = cuelessKind(beat);
    return kind === undefined ? [] : [cuelessStill(script, beat, kind)];
  });
  return [`beats whose picture would stand still more than ${staticMaxS} s between reveals, outside the reading time of unspoken text: ${named.join("; ")}. ${fix}, or hold the beat with heldS if its point should sit with the viewer (at most ${held[1]} held beats in all)`, ...cueless].join("; ");
}

function heldHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const [min, max] = scriptPacing(script)?.held ?? [row.threshold, row.threshold];
  const held = heldBeats(script.beats);
  if (held.length > max) return `${held.length} beats are held (${listed(held)}), past the profile's ${min}-${max}; drop heldS from all but ${max}, and give none of the rest the "held" band`;
  const wanted = min - held.length === 1 ? "the beat" : `${min - held.length} beats`;
  return `${held.length} beats are held, under the profile's ${min}-${max}; set heldS (the seconds its still frame holds after its words) on ${wanted} whose point should sit with the viewer, ${holdable(script, held)}`;
}

// Holding a beat excuses no cue gap (qa's picture-change has no held exemption), so only a beat Q-D17 passes is offered.
function holdable(script: ScriptV1, held: readonly string[]): string {
  const failS = scriptPacing(script)?.pictureChangeFailS ?? PACING_DEFAULTS.pictureChangeFailS;
  const candidates = bodyBeats(script.beats).filter((beat) => !held.includes(beat.id) && (longestCueGapS(beat) ?? Infinity) <= failS);
  const pieces = `a piece of a long beat split so no stretch runs past ${failS} s`;
  if (candidates.length === 0) return `such as ${pieces}; no beat now keeps every stretch within ${failS} s`;
  const still = candidates.filter((beat) => beatCues(beat.visual).length === 0).map((beat) => beat.id);
  return `such as a short reflection or claim (beats whose stretches stay within ${failS} s: ${listed(still.length > 0 ? still : candidates.map((beat) => beat.id))}), or ${pieces}`;
}

function fillHint(script: ScriptV1, row: Parameters<Hint>[1]): string {
  const ids = new Set(row.detail_beats);
  const named = underfilledBeats(script.beats)
    .filter(({ beat }) => ids.has(beat.id))
    .map(({ beat, budget }) => `${beat.id} ${budget.words}/${budget.cap} words (write at least ${Math.ceil(FILL_FLOOR * budget.cap)})`);
  return `beats speaking under ${Math.round(FILL_FLOOR * 100)} % of their word cap: ${named.join(", ")}. Write each closer to its cap, more of the point and not filler, so the runtime holds when each beat ends after its last word; or lower plannedS and give the seconds to a beat that needs them`;
}

const headingHint: Hint = (script, row) => {
  const failing = new Set(row.detail_beats);
  const named = [
    ...refusedNotes(script, row),
    ...overlongTexts(script)
      .filter((found) => failing.has(found.beat))
      .map((found) => `${found.beat} (as ${found.kind}): ${found.texts.map((shown) => `${shown.role} "${clipped(shown.text)}"`).join(", ")}`),
  ];
  const holds = namedBeats(script, row).flatMap((beat) => shortenedStill(script, beat) ?? []);
  return [`on-screen text over its cap, a heading at most ${HEADING_MAX_WORDS} words and a label at most ${LABEL_MAX_WORDS}: ${named.join("; ")}. An outro or button draws its first label (or, with none, the assertion) as its heading line; shorten each heading or label to its key words and say the rest`, ...holds].join("; ");
};

// The label's reading time is what keeps a cue-less kind's picture from standing still, so shortening it can swap
// Q-D20 for Q-D22; the hold answers both and adds no words, and with the band full, unspoken words keep that time.
function shortenedStill(script: ScriptV1, beat: ScriptBeat): string | undefined {
  const kind = cuelessKind(beat);
  if (kind === undefined || kind === CLAIM_CARD || heldBeats([beat]).length > 0) return undefined;
  const lead = `${beat.id} is a ${kind}, which reveals nothing on a cue, so a shorter label leaves it standing still`;
  const full = fullBand(script);
  if (full !== undefined) return `${lead}, and ${full}: write the short label in words the voice does not read word for word, so its reading time keeps the picture from standing still, to pass ${capClauses(["Q-D22"])}`;
  return `${lead}: hold it with heldS as well (at most ${(scriptPacing(script) ?? PACING_DEFAULTS).held[1]} held beats in all), to pass ${capClauses(["Q-D22"])}`;
}

const motionHint: Hint = (script, row) => {
  const failing = new Set(row.detail_beats);
  const still = stillOpenings(script).filter((found) => failing.has(found.beat));
  const named = [...refusedNotes(script, row), ...still.map((found) => `${found.beat} (as ${found.kind}, first moves at ${found.firstS} s)`)];
  return `beats whose picture holds still past 0.2 s after the cut: ${named.join(", ")}. Each draws no headline and opens on an element that waits for its spoken cue; cite the beat's source in a chip, whose line rises at once, or draw it as a kind with a headline`;
};

export const SCREEN_HINTS: Readonly<Record<string, Hint>> = {
  "Q-D14": numbersHint,
  "Q-D15": frameHint,
  "Q-D20": headingHint,
  "Q-D21": motionHint,
  "Q-D16": echoHint,
  "Q-D17": cueGapHint,
  "Q-D22": stillHint,
  "Q-D18": heldHint,
  "Q-D19": fillHint,
};
