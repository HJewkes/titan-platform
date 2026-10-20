import type { SentenceVet } from "./speech-vet-gate.js";

export const DEFAULT_VET_VOICE = "af_heart";

/**
 * speech-vet's `vet` over in-process Kokoro and Whisper on the host's speech runtime. Nothing costs money, but the
 * first call downloads both models into the runtime cache, so the imports wait until a run asks for vetting.
 */
export async function localSentenceVet(voice: string = DEFAULT_VET_VOICE): Promise<SentenceVet> {
  const [{ misakiEnglish }, { whisperStt }, { kokoroProvider, resolveSpeechRuntime, runtimeOptions }, { normalize, vet }] = await Promise.all([
    import("@titan-design/speech-g2p"),
    import("@titan-design/speech-stt"),
    import("@titan-design/speech-tts"),
    import("@titan-design/speech-vet"),
  ]);
  const runtime = await resolveSpeechRuntime();
  const g2p = misakiEnglish();
  const tts = kokoroProvider({ g2p, ...runtimeOptions(runtime, "tts"), onWarning: (message) => console.error(`warning: ${message}`) });
  const stt = whisperStt(runtimeOptions(runtime, "stt"));
  return (sentence) => vet(normalize(sentence), { tts, voice, stt, g2p });
}
