import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { calibrateSpeed, encodeWav, type Audio, type TtsProvider } from "@titan-design/speech-tts";
import type { SpeechBand } from "../beat-schema.js";
import { keptBeats, ResolvedSchema } from "../resolve-stage.js";
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

/**
 * The voice a stage speaks in, and where it came from: the run's profile, a tts variant, or the default. `rate`
 * scales every band's words a minute, so profiles keep distinct paces at the same band.
 */
export interface StageVoice {
  id: string;
  rate: number;
  source: string;
}

/** The voice, and the words a minute each speech band is voiced at (doctrine `speech-bands.yaml`). */
export interface StageSpeech {
  voice: StageVoice;
  rates: Readonly<Record<SpeechBand, number>>;
}

/** The rate one beat is voiced at: its beat type's band, at that band's words a minute times the voice rate. */
interface BeatRate {
  band: SpeechBand;
  rateWpm: number;
}

interface TtsStageInput {
  artifacts: Readonly<Record<string, string>>;
  store: Pick<ArtifactStore, "readText" | "putText" | "putTree">;
  from: Provenance;
}

interface TtsStageDeps {
  engine: () => Promise<TtsEngine>;
  /** The per-beat take cache's directory. */
  takesDir: string;
  padding?: Padding;
}

interface VoicedBeat extends BeatRate {
  id: string;
  spoken: string;
  wordCount: number;
  plannedS: number;
  speechS: number;
  durationS: number;
  cached: boolean;
  /** The Kokoro speed calibration settled on, and the articulation rate it measured. */
  speed: number;
  wpm: number;
  /** Beat-relative, lead included: what the render path and the cue checks read. */
  words: TimedWord[];
  heard: TimedWord[];
  wav: Uint8Array;
}

const spokenWords = (spoken: string): string[] => spoken.split(/\s+/).filter(Boolean);

const tenths = (value: number): number => Math.round(value * 10) / 10;

/**
 * Each beat's band from the resolve stage's beat type, and its rate; a beat resolve cut is not voiced, and any other
 * beat the resolver left out stops the stage.
 */
function beatRates(script: ScriptV1, input: TtsStageInput, speech: StageSpeech): Map<string, BeatRate> {
  const sha = input.artifacts.resolved;
  if (sha === undefined) throw new Error(`stage tts needs artifact "resolved", which no earlier stage produced`);
  const resolved = ResolvedSchema.parse(JSON.parse(input.store.readText(sha)));
  const bands = new Map(resolved.beats.map((beat) => [beat.id, beat.band]));
  return new Map(keptBeats(script.beats, resolved).map((beat) => {
    const band = bands.get(beat.id);
    if (band === undefined) throw new Error(`stage tts: beat ${beat.id} has no band in "resolved"; re-run resolve on this script`);
    return [beat.id, { band, rateWpm: tenths(speech.rates[band] * speech.voice.rate) }];
  }));
}

/** A take calibrated to the beat's words a minute: Kokoro's speed is stepped until the measured rate lands in band. */
async function takeFor(spoken: string, rateWpm: number, voice: StageVoice, engine: TtsEngine, cache: TakeCache): Promise<Take & { cached: boolean }> {
  const key = takeKey({ spoken, voice: voice.id, rateWpm, engine: engine.version });
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const { best } = await calibrateSpeed(engine.provider, { text: spoken }, voice.id, { targetWpm: rateWpm, wordCount: spokenWords(spoken).length });
  if (!best.synthesis.words) throw new Error(`tts provider ${engine.provider.id} reports no word timings; the tts stage needs them to time cues`);
  const take = { audio: best.synthesis.audio, words: best.synthesis.words, speed: best.speed, wpm: best.wpm };
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

interface Voicing {
  voice: StageVoice;
  engine: TtsEngine;
  cache: TakeCache;
  padding: Padding;
}

/** Truing reads the calibrated take, so a beat's length is the length of speech at its band's rate. */
async function voiceBeat(beat: ScriptV1["beats"][number], rate: BeatRate, { voice, engine, cache, padding }: Voicing): Promise<VoicedBeat> {
  const take = await takeFor(beat.spoken, rate.rateWpm, voice, engine, cache);
  const script = spokenWords(beat.spoken);
  const speechS = take.audio.samples.length / take.audio.sampleRate;
  return {
    id: beat.id, ...rate, spoken: beat.spoken, wordCount: script.length, plannedS: beat.plannedS, speechS: Math.round(speechS * 1000) / 1000,
    durationS: trueDuration(beat.plannedS, speechS, padding), cached: take.cached, speed: take.speed, wpm: take.wpm,
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

/** `voice.json`: the voice band, and per beat the band, the rate it was calibrated to, the speed found and the rate measured. */
function voiceFile(beats: readonly VoicedBeat[], voice: StageVoice, engine: TtsEngine) {
  return {
    schema: "explainer.voice/v2", provider: engine.provider.id, engine: engine.version, id: voice.id, rate: voice.rate, source: voice.source,
    beats: beats.map((b) => ({ id: b.id, band: b.band, rateWpm: b.rateWpm, speed: b.speed, wpm: b.wpm })),
  };
}

/**
 * The `explainer.tts` body: one take per beat at its band's rate (from the take cache when its key is known),
 * realigned, trued and laid end to end.
 */
export async function runTtsStage(input: TtsStageInput, speech: StageSpeech, deps: TtsStageDeps): Promise<StageOutcome> {
  const sha = input.artifacts.script;
  if (sha === undefined) throw new Error(`stage tts needs artifact "script", which no earlier stage produced`);
  const script = parseScript(JSON.parse(input.store.readText(sha)));
  const rates = beatRates(script, input, speech);
  const { voice } = speech;
  const engine = await deps.engine();
  const padding = deps.padding ?? DEFAULT_PADDING;
  const voicing: Voicing = { voice, engine, cache: new TakeCache(deps.takesDir), padding };
  const beats: VoicedBeat[] = [];
  for (const beat of script.beats) {
    const rate = rates.get(beat.id);
    if (rate) beats.push(await voiceBeat(beat, rate, voicing));
  }
  const audioDir = mkdtempSync(path.join(tmpdir(), "explainer-tts-"));
  try {
    for (const beat of beats) writeFileSync(path.join(audioDir, `${beat.id}.wav`), beat.wav);
    const words = wordsFile(beats, voice, engine, padding);
    const outputs = {
      words: input.store.putText(json(words), "words", input.from),
      voice: input.store.putText(json(voiceFile(beats, voice, engine)), "voice", input.from),
      audio: input.store.putTree(audioDir, "audio", input.from),
    };
    const total = words.beats.reduce((sum, b) => sum + b.durationS, 0);
    const reused = beats.filter((b) => b.cached).length;
    return { outputs, notes: [`${beats.length} beats voiced as ${voice.id} at ${voice.rate}x the band rates (${voice.source}); ${reused} from the take cache; ${total.toFixed(2)} s`] };
  } finally {
    rmSync(audioDir, { recursive: true, force: true });
  }
}
