import { misakiEnglish } from "@titan-design/speech-g2p";
import { WAV2VEC2_MODEL, WAV2VEC2_REVISION, wav2vec2Recognizer, whisperStt } from "@titan-design/speech-stt";
import { kokoroProvider, type Audio, type SpeechDevice } from "@titan-design/speech-tts";

export interface EngineRuntime {
  device: SpeechDevice;
  cacheDir: string;
}

export interface ModelInfo {
  model: string;
  revision: string;
  dtype: string;
}

export interface SmokeTts extends ModelInfo {
  synthesize(text: string, voice: string): Promise<Audio>;
}

export interface SmokeStt extends ModelInfo {
  /** Must run the model on every call: a cached warm call would report an infinite real-time factor. */
  transcribe(audio: Audio): Promise<string>;
  dispose(): Promise<void>;
}

export interface SmokePhones extends ModelInfo {
  recognize(audio: Audio): Promise<{ phones: string; frames: number }>;
  dispose(): Promise<void>;
}

/** The models a smoke run drives. Tests pass fakes, so no model is downloaded or loaded. */
export interface SmokeEngines {
  tts(runtime: EngineRuntime): SmokeTts;
  stt(runtime: EngineRuntime): SmokeStt;
  phones(runtime: EngineRuntime): SmokePhones;
}

const WHISPER_MODEL = "onnx-community/whisper-base.en_timestamped";
const UNPINNED = "main (unpinned)";
const noCache = { get: () => undefined, set: () => undefined };

function kokoroTts(runtime: EngineRuntime): SmokeTts {
  const tts = kokoroProvider({ g2p: misakiEnglish(), ...runtime, onWarning: (m) => console.error(`warn: ${m}`) });
  return {
    model: "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped",
    revision: UNPINNED,
    dtype: "fp32",
    synthesize: async (text, voice) => (await tts.synthesize({ text }, voice, { speed: 1 })).audio,
  };
}

function whisper(runtime: EngineRuntime): SmokeStt {
  const stt = whisperStt({ ...runtime, model: WHISPER_MODEL, dtype: "fp32", cache: noCache });
  return {
    model: WHISPER_MODEL,
    revision: UNPINNED,
    dtype: "fp32",
    transcribe: async (audio) => (await stt.transcribe(audio)).words.map((w) => w.text).join(" "),
    dispose: () => stt.dispose(),
  };
}

function wav2vec2(runtime: EngineRuntime): SmokePhones {
  const rec = wav2vec2Recognizer({ ...runtime, dtype: "fp32" });
  return {
    model: WAV2VEC2_MODEL,
    revision: WAV2VEC2_REVISION,
    dtype: "fp32",
    recognize: async (audio) => {
      const { phones, logits } = await rec.recognizeWithLogits(audio);
      return { phones, frames: logits.frames };
    },
    dispose: () => rec.dispose(),
  };
}

/** Kokoro, Whisper base.en and wav2vec2 lv-60 espeak, each at fp32, as spike E8 ran them. */
export const realEngines: SmokeEngines = { tts: kokoroTts, stt: whisper, phones: wav2vec2 };
