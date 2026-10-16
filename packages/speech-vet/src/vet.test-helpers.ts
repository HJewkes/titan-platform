import type { SttCapabilities, SttProvider, Transcript } from "@titan-design/speech-stt";
import type { PhoneRecognizer } from "./phone-verdicts.js";

/** A transcript of `text` with evenly spaced words, as a recognizer would time a short constructed line. */
export function transcriptOf(text: string, avgLogprob?: number): Transcript {
  const words = text.split(" ").map((w, i) => ({ text: w, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const segment = { text, start: 0, end: words.length * 0.3, ...(avgLogprob === undefined ? {} : { avgLogprob }) };
  return { text, words, segments: [segment] };
}

/** The i-th call gets the i-th entry, and calls past the script repeat the last one. */
function nth<T>(script: readonly T[], call: number): T {
  const entry = script[Math.min(call, script.length - 1)];
  if (entry === undefined) throw new RangeError("a scripted fake needs at least one entry");
  return entry;
}

/** An STT that returns the i-th transcript on the i-th call and counts its calls. */
export function scriptedStt(transcripts: readonly Transcript[], capabilities: SttCapabilities = { tokenLogprobs: false }): SttProvider & { calls: number } {
  const provider = {
    calls: 0,
    capabilities,
    transcribe: (): Promise<Transcript> => Promise.resolve(nth(transcripts, provider.calls++)),
  };
  return provider;
}

/** A phone recognizer that returns the i-th phone string on the i-th call and counts its calls. */
export function scriptedRecognizer(phones: readonly string[]): PhoneRecognizer & { calls: number } {
  const recognizer = {
    calls: 0,
    recognize: (): Promise<string> => Promise.resolve(nth(phones, recognizer.calls++)),
  };
  return recognizer;
}
