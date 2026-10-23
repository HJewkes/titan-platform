import { misakiEnglish } from "@titan-design/speech-g2p";
import { kokoroProvider } from "@titan-design/speech-tts";
import { describe, expect, it } from "vitest";
import { loadProfiles } from "./profile-load.js";

// Runs only on request, and offline: SPEECH_TTS_SMOKE_CACHE must already hold the fp32 Kokoro model (see "Smoke
// check" in the speech-tts README). Then: SPEECH_TTS_SMOKE_CACHE=<cache dir> pnpm vitest run profile-voices.smoke
const cacheDir = process.env.SPEECH_TTS_SMOKE_CACHE;

const SENTENCE = "This change keeps the build green.";
const voices = [...loadProfiles().profiles.values()].map((profile) => [profile.type, profile.voice] as const);

describe.skipIf(!cacheDir)("each shipped profile's voice on a real Kokoro model", () => {
  const tts = kokoroProvider({ g2p: misakiEnglish(), ...(cacheDir ? { cacheDir } : {}), unknownWords: "fail" });

  it.each(voices)("%s speaks one sentence", async (_type, { id, rate }) => {
    const { durationS, words } = await tts.synthesize({ text: SENTENCE }, id, { speed: rate });

    expect(durationS).toBeGreaterThan(0.5);
    expect(words?.filter((word) => word.end > word.start)).toHaveLength(6);
  }, 300_000);
});
