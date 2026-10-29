import { cuelessKind, FILL_FLOOR, heldBeats, longestCueGapS, scriptPacing, underfilledBeats } from "./lint-cadence.js";
import { PACING_DEFAULTS } from "./qa/timing-gates.js";
import { bodyBeats } from "./lint-text.js";
import { FRAME_MAX_WORDS, frameCounts } from "./lint-frame-words.js";
import { HEADING_MAX_WORDS, LABEL_MAX_WORDS, overlongTexts, stillOpenings } from "./lint-direction.js";
import { ECHO_RUN_WORDS, echoedLabels, unspokenNumbers } from "./lint-screen.js";
import { clipped, listed, namedBeats, quoted, type Hint } from "./repair-hint.js";
import { beatCues, type ScriptBeat, type ScriptV1 } from "./script-schema.js";

const seconds = (s: number): string => `${Math.round(s * 10) / 10} s`;

const numbersHint: Hint = (script, row) => {
  const named = namedBeats(script, row).map((beat) => `${beat.id} shows ${unspokenNumbers(script, beat).map(({ fact, shown }) => `"${fact}" (in "${clipped(shown)}")`).join(", ")}`);
  return `on-screen numbers the beat never says: ${named.join("; ")}. Say each number in that beat's spoken text, or drop it from the assertion, labels, chips or chapter label: say it or drop it`;
};

const frameHint: Hint = (script, row) => {
  const failing = new Set(row.detail_beats);
  const named = frameCounts(script).filter((count) => failing.has(count.beat)).map((count) => `${count.beat} (${count.words} words as ${count.kind})`);
  return `beats whose fullest frame shows more than ${FRAME_MAX_WORDS} words, headline, rows and source line together: ${named.join(", ")}. Write rows as key words, not sentences, and move the rest to the narration`;
};

const echoHint: Hint = (script, row) => {
  const named = namedBeats(script, row).map((beat) => `${beat.id} ${quoted(echoedLabels(script, beat).map(clipped))}`);
  return `on-screen texts repeating ${ECHO_RUN_WORDS} or more spoken words in a row: ${named.join("; ")}. Keep the key words, not the sentence: the screen names it, the voice says it`;
};

// A kind with no emphasis targets takes no cue and heldS excuses no stretch, so its only moves are a split or a cued kind.
function cuelessMove(beat: ScriptBeat, kind: string, failS: number): string {
  const parts = Math.ceil((longestCueGapS(beat) ?? beat.plannedS) / failS);
  return `${beat.id} is a ${kind}, which takes no cue, and heldS does not excuse its stretch: split it into ${parts} ${kind} beats of at most ${failS} s of words each, or draw it as a list whose rows each land on a cue`;
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
  const named = overlongTexts(script)
    .filter((found) => failing.has(found.beat))
    .map((found) => `${found.beat} (as ${found.kind}): ${found.texts.map((shown) => `${shown.role} "${clipped(shown.text)}"`).join(", ")}`);
  return `on-screen text over its cap, a heading at most ${HEADING_MAX_WORDS} words and a label at most ${LABEL_MAX_WORDS}: ${named.join("; ")}. An outro or button draws its first label (or, with none, the assertion) as its heading line; shorten each heading or label to its key words and say the rest`;
};

const motionHint: Hint = (script, row) => {
  const failing = new Set(row.detail_beats);
  const named = stillOpenings(script).filter((found) => failing.has(found.beat)).map((found) => `${found.beat} (as ${found.kind}, first moves at ${found.firstS} s)`);
  return `beats whose picture holds still past 0.2 s after the cut: ${named.join(", ")}. Each draws no headline and opens on an element that waits for its spoken cue; cite the beat's source in a chip, whose line rises at once, or draw it as a kind with a headline`;
};

export const SCREEN_HINTS: Readonly<Record<string, Hint>> = {
  "Q-D14": numbersHint,
  "Q-D15": frameHint,
  "Q-D20": headingHint,
  "Q-D21": motionHint,
  "Q-D16": echoHint,
  "Q-D17": cueGapHint,
  "Q-D18": heldHint,
  "Q-D19": fillHint,
};
