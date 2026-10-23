import type { TtsEngine } from "./tts-stage.js";

/**
 * The take cache's engine build: Kokoro-82M at fp32 over speech-g2p's misaki English. Bump it when either changes
 * what Kokoro says for the same text, so every cached take is re-voiced.
 */
const KOKORO_ENGINE_VERSION = "kokoro-82m-fp32+misaki-en/1";

/**
 * speech-tts Kokoro in process, on the host's speech runtime. `unknownWords: "fail"` (owner, TP-3032 s7 item 9): a
 * word with no phonemes stops the stage before any audio is made, rather than playing as silence under a cue.
 * The imports wait for the first call, since the model loads (and on first use downloads) only when a run voices.
 */
export async function kokoroEngine(): Promise<TtsEngine> {
  const [{ misakiEnglish }, { kokoroProvider, resolveSpeechRuntime, runtimeOptions }] = await Promise.all([
    import("@titan-design/speech-g2p"),
    import("@titan-design/speech-tts"),
  ]);
  const runtime = await resolveSpeechRuntime();
  const provider = kokoroProvider({ g2p: misakiEnglish(), unknownWords: "fail", ...runtimeOptions(runtime, "tts") });
  return { provider, version: KOKORO_ENGINE_VERSION };
}
