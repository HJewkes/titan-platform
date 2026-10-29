import { checkReadings, englishHeteronyms, plainText, type HeteronymTable, type PhonemeToken } from "@titan-design/speech-vet";
import type { L0Check } from "./eval-l0.js";
import { countRow } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// The apostrophe stays inside a word, as in speech-vet's occurrence count, so ordinals line up with its declarations.
const WORD = /[A-Za-z]+(?:'[A-Za-z]+)*/g;
// A place counts numbers too, as a model counting the line's words would, so "about 18 minutes" puts minutes third.
const PLACE = /[A-Za-z0-9]+(?:'[A-Za-z]+)*/g;

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

/** One unsettled occurrence: the word, the readings that would settle it, and its one-based place among the line's words. */
export interface UnsettledHeteronym {
  word: string;
  readings: string[];
  /** Absent for a declaration whose word the line does not say. */
  position?: number;
}

function positionOf(spoken: string, word: string, occurrence: number): number | undefined {
  const form = word.toLowerCase();
  const places = [...plainText(spoken).matchAll(PLACE)].map(([text]) => text.toLowerCase());
  const index = places.flatMap((text, i) => (text === form ? [i] : []))[occurrence - 1];
  return index === undefined ? undefined : index + 1;
}

/** Each heteronym occurrence with neither a `[w](=reading)` naming a reading the table knows nor a `[w](/phonemes/)` override. */
export function unsettledHeteronyms(spoken: string, table: HeteronymTable = englishHeteronyms): UnsettledHeteronym[] {
  const tokens = textTokens(spoken);
  return checkReadings(spoken, tokens, table)
    .filter(({ word, declared, status }) => (declared === null ? status === "warn" : !readingNames(table, word.toLowerCase()).includes(declared)))
    .map(({ word, occurrence }) => {
      const position = positionOf(spoken, word, occurrence);
      return { word, readings: readingNames(table, word.toLowerCase()), ...(position === undefined ? {} : { position }) };
    });
}

/** Where each unsettled heteronym is, as `w3 "minutes" (word 12)`, so a failing row names the word, not just its beat. */
export const heteronymPlaces = (beats: readonly Pick<ScriptBeat, "id" | "spoken">[]): string[] =>
  beats.flatMap((beat) =>
    unsettledHeteronyms(beat.spoken).map(({ word, position }) => `${beat.id} "${word}"${position === undefined ? "" : ` (word ${position})`}`),
  );

const unsettledBeats = (beats: readonly ScriptBeat[], table: HeteronymTable): string[] =>
  beats.filter((beat) => unsettledHeteronyms(beat.spoken, table).length > 0).map((beat) => beat.id);

/** Q-V10: every heteronym the voice will say is declared or overridden, so a tagger change cannot flip it unheard. */
export function heteronymCheckWith(table: HeteronymTable = englishHeteronyms): L0Check {
  return ({ script }) => [countRow("Q-V10", unsettledBeats(script.beats, table))];
}

export const heteronymCheck: L0Check = heteronymCheckWith();
