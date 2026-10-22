import type { L0Check } from "./eval-l0.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, vettableSentences, voiceCheck, voiceCheckWith, type SpeechVerdict } from "./lint-voice.js";
import type { ScriptV1 } from "./script-schema.js";

export const VETTED_RANGE = `${MAX_SENTENCE_WORDS + 1}-${MAX_VETTED_SENTENCE_WORDS}`;

/** Vets one sentence; `accepted` is the only status that counts as clean to speak. */
export type SentenceVet = (sentence: string) => Promise<{ status: string }>;

export interface SentenceVerdict {
  sentence: string;
  status: string;
  clean: boolean;
}

async function statusOf(vetSentence: SentenceVet, sentence: string): Promise<string> {
  try {
    return (await vetSentence(sentence)).status;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Vets each sentence of 26 to 32 words of the script, one at a time since each vet loads and runs speech models.
 * A vet that throws is a verdict of not clean, so Q-V9 never fails open.
 */
export async function vetSentences(script: ScriptV1, vetSentence: SentenceVet): Promise<SentenceVerdict[]> {
  const verdicts: SentenceVerdict[] = [];
  for (const sentence of vettableSentences(script.beats)) {
    const status = await statusOf(vetSentence, sentence);
    verdicts.push({ sentence, status, clean: status === "accepted" });
  }
  return verdicts;
}

export function speechVerdict(verdicts: readonly SentenceVerdict[]): SpeechVerdict {
  const clean = new Set(verdicts.filter((v) => v.clean).map((v) => v.sentence));
  return (sentence) => clean.has(sentence);
}

/** The check list with the voice check swapped for one that reads the verdicts; other checks are untouched. */
export const withSpeechVerdict = (checks: readonly L0Check[], speechClean: SpeechVerdict): L0Check[] =>
  checks.map((check) => (check === voiceCheck ? voiceCheckWith([], { speechClean }) : check));

/** One line for stderr: how many sentences were vetted and how they came out. */
export function verdictSummary(verdicts: readonly SentenceVerdict[]): string {
  const counts = new Map<string, number>();
  const kindOf = (status: string): string => (status.startsWith("error:") ? "error" : status);
  verdicts.forEach(({ status }) => counts.set(kindOf(status), (counts.get(kindOf(status)) ?? 0) + 1));
  const byStatus = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
  return `speech-vet: vetted ${verdicts.length} sentence(s) of ${VETTED_RANGE} words${byStatus ? `: ${byStatus}` : ""}`;
}
