import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { SPEECH_BANDS } from "./beat-schema.js";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";

const SpeechBandRateSchema = z.object({ wpm: z.number().positive(), wordsPerS: z.number().positive() }).strict();

const SpeechBandsFileSchema = z
  .object({ schema: z.literal("speech-bands/v1"), bands: z.record(z.enum(SPEECH_BANDS), SpeechBandRateSchema) })
  .strict();

/** Every speech band's voiced rate and density cap; the record is exhaustive, so a band with no row fails the load. */
export type SpeechBands = z.infer<typeof SpeechBandsFileSchema>["bands"];

/** Reads `speech-bands.yaml` under `dir`: the one table the tts stage's rates and the word budget's caps come from. */
export function loadSpeechBands(dir: string = DEFAULT_DOCTRINE_DIR): SpeechBands {
  return SpeechBandsFileSchema.parse(parse(readFileSync(join(dir, "speech-bands.yaml"), "utf8"))).bands;
}
