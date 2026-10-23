import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeWav, type Audio, type TtsProvider } from "@titan-design/speech-tts";
import { parseScript } from "../script-load.js";
import type { ScriptV1 } from "../script-schema.js";
import type { ArtifactStore, Provenance } from "./artifacts.js";
import type { StageOutcome } from "./records.js";
import { TakeCache, takeKey, type Take } from "./tts-cache.js";
import { realign } from "./tts-realign.js";
import { beatStarts, DEFAULT_PADDING, shiftWords, trueDuration, type Padding, type TimedWord } from "./tts-truing.js";

/** A provider and the build it runs; the build joins every take's cache key, so a new engine re-voices every beat. */
export interface TtsEngine {
  provider: TtsProvider;
  version: string;
}

/** The voice a stage speaks in, and where it came from: the run's profile, a tts variant, or the default. */
export interface StageVoice {
  id: string;
  rate: number;
  source: string;
}

export interface TtsStageInput {
  artifacts: Readonly<Record<string, string>>;
  store: Pick<ArtifactStore, "readText" | "putText" | "putTree">;
  from: Provenance;
}

export interface TtsStageDeps {
  engine: () => Promise<TtsEngine>;
  /** The per-beat take cache's directory. */
  takesDir: string;
  padding?: Padding;
}

interface VoicedBeat {
  id: string;
  spoken: string;
  wordCount: number;
  plannedS: number;
  speechS: number;
  durationS: number;
  cached: boolean;
  /** Beat-relative, lead included: what the render path and the cue checks read. */
  words: TimedWord[];
  heard: TimedWord[];
  wav: Uint8Array;
}

const spokenWords = (spoken: string): string[] => spoken.split(/\s+/).filter(Boolean);

async function takeFor(spoken: string, voice: StageVoice, engine: TtsEngine, cache: TakeCache): Promise<Take & { cached: boolean }> {
  const key = takeKey({ spoken, voice: voice.id, rate: voice.rate, engine: engine.version });
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const synthesis = await engine.provider.synthesize({ text: spoken }, voice.id, { speed: voice.rate });
  if (!synthesis.words) throw new Error(`tts provider ${engine.provider.id} reports no word timings; the tts stage needs them to time cues`);
  const take = { audio: synthesis.audio, words: synthesis.words };
  cache.put(key, take);
  return { ...take, cached: false };
}

/** The take with the lead's silence before it, so a word's beat-relative time is also its time in the WAV. */
function padded(audio: Audio, leadS: number): Uint8Array {
  const lead = Math.round(leadS * audio.sampleRate);
  const samples = new Float32Array(lead + audio.samples.length);
  samples.set(audio.samples, lead);
  return encodeWav({ samples, sampleRate: audio.sampleRate });
}

async function voiceBeat(beat: ScriptV1["beats"][number], voice: StageVoice, engine: TtsEngine, cache: TakeCache, padding: Padding): Promise<VoicedBeat> {
  const take = await takeFor(beat.spoken, voice, engine, cache);
  const script = spokenWords(beat.spoken);
  const speechS = take.audio.samples.length / take.audio.sampleRate;
  return {
    id: beat.id, spoken: beat.spoken, wordCount: script.length, plannedS: beat.plannedS, speechS: Math.round(speechS * 1000) / 1000,
    durationS: trueDuration(beat.plannedS, speechS, padding), cached: take.cached,
    words: shiftWords(realign(script, take.words), padding.leadS), heard: shiftWords(take.words, padding.leadS), wav: padded(take.audio, padding.leadS),
  };
}

/**
 * `words.json`: per beat its trued length, its start on the video timeline and its words relative to that start
 * (what the render path reads), plus `absolute`, every word on the video timeline (its beat-relative time shifted by
 * the beat's start).
 */
function wordsFile(beats: readonly VoicedBeat[], voice: StageVoice, engine: TtsEngine, padding: Padding) {
  const starts = beatStarts(beats.map((b) => b.durationS));
  return {
    schema: "explainer.words/v1",
    voice: { provider: engine.provider.id, engine: engine.version, id: voice.id, rate: voice.rate },
    timingSource: "engine-durations",
    ...padding,
    beats: beats.map((b, i) => ({
      id: b.id, spoken: b.spoken, wordCount: b.wordCount, plannedS: b.plannedS, speechS: b.speechS, startS: starts[i]!, durationS: b.durationS, words: b.words, heard: b.heard,
    })),
    absolute: beats.flatMap((b, i) => shiftWords(b.words, starts[i]!).map((w) => ({ beat: b.id, ...w }))),
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** The `explainer.tts` body: one take per beat (from the take cache when its key is known), realigned, trued and laid end to end. */
export async function runTtsStage(input: TtsStageInput, voice: StageVoice, deps: TtsStageDeps): Promise<StageOutcome> {
  const sha = input.artifacts.script;
  if (sha === undefined) throw new Error(`stage tts needs artifact "script", which no earlier stage produced`);
  const script = parseScript(JSON.parse(input.store.readText(sha)));
  const engine = await deps.engine();
  const padding = deps.padding ?? DEFAULT_PADDING;
  const cache = new TakeCache(deps.takesDir);
  const beats: VoicedBeat[] = [];
  for (const beat of script.beats) beats.push(await voiceBeat(beat, voice, engine, cache, padding));
  const audioDir = mkdtempSync(path.join(tmpdir(), "explainer-tts-"));
  try {
    for (const beat of beats) writeFileSync(path.join(audioDir, `${beat.id}.wav`), beat.wav);
    const words = wordsFile(beats, voice, engine, padding);
    const voiceJson = { schema: "explainer.voice/v1", provider: engine.provider.id, engine: engine.version, id: voice.id, rate: voice.rate, source: voice.source };
    const outputs = {
      words: input.store.putText(json(words), "words", input.from),
      voice: input.store.putText(json(voiceJson), "voice", input.from),
      audio: input.store.putTree(audioDir, "audio", input.from),
    };
    const total = words.beats.reduce((sum, b) => sum + b.durationS, 0);
    const reused = beats.filter((b) => b.cached).length;
    return { outputs, notes: [`${beats.length} beats voiced as ${voice.id} at ${voice.rate} (${voice.source}); ${reused} from the take cache; ${total.toFixed(2)} s`] };
  } finally {
    rmSync(audioDir, { recursive: true, force: true });
  }
}
