import { checkReadings, englishHeteronyms, plainText, type HeteronymTable, type PhonemeToken } from "@titan-design/speech-vet";
import type { L0Check } from "./eval-l0.js";
import { countRow } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// The apostrophe stays inside a word, as in speech-vet's occurrence count, so ordinals line up with its declarations.
const WORD = /[A-Za-z]+(?:'[A-Za-z]+)*/g;

/**
 * Word tokens with no phonemes. The workspace runs no G2P, so the check can find each heteronym and its declaration
 * but cannot judge which reading a voice would choose; that waits for speech-g2p.
 */
function textTokens(spoken: string): PhonemeToken[] {
  return [...plainText(spoken).matchAll(WORD)].map(([text]) => ({ text, phonemes: null, whitespace: " " }));
}

function readingNames(table: HeteronymTable, form: string): string[] {
  const entry = Object.values(table.words).find(({ forms }) => forms.includes(form));
  return Object.keys(entry?.readings ?? {});
}

/** Each heteronym occurrence with neither a `[w](=reading)` naming a reading the table knows nor a `[w](/phonemes/)` override. */
export function unsettledHeteronyms(spoken: string, table: HeteronymTable = englishHeteronyms): { word: string; readings: string[] }[] {
  return checkReadings(spoken, textTokens(spoken), table)
    .filter(({ word, declared, status }) => (declared === null ? status === "warn" : !readingNames(table, word.toLowerCase()).includes(declared)))
    .map(({ word }) => ({ word, readings: readingNames(table, word.toLowerCase()) }));
}

const unsettledBeats = (beats: readonly ScriptBeat[], table: HeteronymTable): string[] =>
  beats.filter((beat) => unsettledHeteronyms(beat.spoken, table).length > 0).map((beat) => beat.id);

/** Q-V10: every heteronym the voice will say is declared or overridden, so a tagger change cannot flip it unheard. */
export function heteronymCheckWith(table: HeteronymTable = englishHeteronyms): L0Check {
  return ({ script }) => [countRow("Q-V10", unsettledBeats(script.beats, table))];
}

export const heteronymCheck: L0Check = heteronymCheckWith();
