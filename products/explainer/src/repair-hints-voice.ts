import type { L0Result } from "./eval-l0.js";
import { wordsOf } from "./lint-text.js";
import { MAX_SENTENCE_WORDS, MIN_PROJECT_SHARE, offendingSentences } from "./lint-voice.js";
import { clipped, listed, namedBeats, percent, type Hint } from "./repair-hint.js";
import type { ScriptV1 } from "./script-schema.js";

/** Each sentence a sentence-level voice rule matches in the row's beats, quoted with its beat. */
function quotes(script: ScriptV1, row: L0Result, words = false): string {
  const found = offendingSentences(row.check_id, script, namedBeats(script, row));
  return found.map(({ beat, text }) => `${beat}${words ? ` (${wordsOf(text).length} words)` : ""} "${clipped(text)}"`).join("; ");
}

function verdictPlacementHint(script: ScriptV1, row: L0Result): string {
  return namedBeats(script, row).map((beat) => {
    if (beat.function !== "VERDICT") return `${quotes(script, { ...row, detail_beats: [beat.id] })} uses verdict words (adopt, verdict, avoid it) outside a VERDICT beat; reword it`;
    const lastHow = script.beats.filter((b) => b.chapter === beat.chapter && b.function === "HOW").at(-1);
    return `VERDICT beat ${beat.id} comes before ${beat.chapter}'s last HOW beat ${lastHow?.id ?? ""}; move it after that beat`;
  }).join("; ");
}

/** The voice rules: Q-V1 to Q-V9. */
export const VOICE_HINTS: Readonly<Record<string, Hint>> = {
  "Q-V1": (script, row) =>
    `process narration: ${quotes(script, row)}. Say what the project does, not what anyone reviewed, checked, traced or verified`,
  "Q-V2": (_script, row) =>
    `${listed(row.detail_beats)} put a provenance phrase (from the review, docs claim, reconstructed) or an internal id such as AB-CD-12 in spoken, assertion or labels; move it to a chip, or drop it`,
  "Q-V3": verdictPlacementHint,
  "Q-V4": (_script, row) => `${listed(row.detail_beats)} say "chapter" with a number, or carry a chapter label that starts "Chapter"; name the move instead`,
  "Q-V5": (script, row) =>
    `${percent(row.value)} of the spoken sentences outside VERDICT beats are about the project (needs ${percent(MIN_PROJECT_SHARE)}); make these about what the project does: ${quotes(script, row)}`,
  "Q-V7": (script, row) =>
    `banned register: ${quotes(script, row)}. Drop "simply", "easy", "please note", "in this video" and "you'll learn", and never open a sentence on "there is" or "there are"`,
  "Q-V8": (_script, row) =>
    `${listed(row.detail_beats)} point at the screen (on the left, as you can see, look at, this box) with no V6 or V9 cue; add a V6 cue on the word that points, or say it without pointing`,
  "Q-V9": (script, row) => `sentences over ${MAX_SENTENCE_WORDS} words: ${quotes(script, row, true)}. Split each into sentences of ${MAX_SENTENCE_WORDS} words or fewer`,
};
