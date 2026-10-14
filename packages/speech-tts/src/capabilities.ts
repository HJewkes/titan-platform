import { TtsUnsupportedError } from "./errors.js";
import type { SynthesizeOptions, TtsCapabilities, TtsInput, TtsRequirements } from "./types.js";

const primary = (tag: string): string => tag.toLowerCase().split("-")[0] ?? "";

/** `en` matches `en-US` in either direction; `en-GB` does not match `en-US`. */
export function languageMatches(offered: readonly string[], wanted: string): boolean {
  return offered.some((tag) => {
    const a = tag.toLowerCase();
    const b = wanted.toLowerCase();
    if (a === b) return true;
    const eitherBare = !a.includes("-") || !b.includes("-");
    return eitherBare && primary(a) === primary(b);
  });
}

/** One readable phrase per requirement the capabilities do not meet; empty when all are met. */
export function missingCapabilities(caps: TtsCapabilities, req: TtsRequirements): string[] {
  const missing: string[] = [];
  if (req.phonemeInput && !caps.phonemeInput.includes(req.phonemeInput)) missing.push(`phoneme input (${req.phonemeInput})`);
  if (req.wordTimestamps && !caps.wordTimestamps) missing.push("word timestamps");
  if (req.speedControl && !caps.speedControl) missing.push("speed control");
  if (req.voice !== undefined && !caps.voices.some((v) => v.id === req.voice)) missing.push(`voice "${req.voice}"`);
  if (req.language !== undefined && !languageMatches(caps.languages, req.language)) missing.push(`language "${req.language}"`);
  if (req.sampleRate !== undefined && caps.sampleRate !== req.sampleRate) missing.push(`sample rate ${req.sampleRate} Hz`);
  return missing;
}

/** The requirements one synthesize call implies. A speed of exactly 1 asks for nothing. */
export function requirementsOf(input: TtsInput, voice: string, options: SynthesizeOptions = {}): TtsRequirements {
  return {
    voice,
    ...("tokens" in input ? { phonemeInput: input.alphabet } : {}),
    ...(options.speed !== undefined && options.speed !== 1 ? { speedControl: true } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
  };
}

/** Throws before any engine work when the call needs a capability the provider does not declare. */
export function assertSupported(
  providerId: string,
  caps: TtsCapabilities,
  input: TtsInput,
  voice: string,
  options?: SynthesizeOptions,
): void {
  const missing = missingCapabilities(caps, requirementsOf(input, voice, options));
  if (missing.length > 0) throw new TtsUnsupportedError(providerId, missing);
}
