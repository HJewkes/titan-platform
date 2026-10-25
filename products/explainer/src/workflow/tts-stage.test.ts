import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeWav, TtsUnknownWordsError, type KokoroEngine, type TtsProvider } from "@titan-design/speech-tts";
import type { Lexicon } from "@titan-design/speech-vet";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import type { SpeechBand } from "../beat-schema.js";
import type { ScriptV1 } from "../script-schema.js";
import { artifactMigration, ArtifactStore } from "./artifacts.js";
import { kokoroEngine } from "./tts-engine.js";
import { runTtsStage, type StageSpeech, type StageVoice, type TtsEngine } from "./tts-stage.js";
import { DEFAULT_PADDING, trueDuration } from "./tts-truing.js";

const RATE = 1000;
const VOICE: StageVoice = { id: "af_heart", rate: 1, source: "default" };
/** Words a minute per band for these tests: round numbers the fake voice can hit exactly. */
const RATES: Record<SpeechBand, number> = { story: 180, concept: 120, code: 40, takeaways: 150, held: 150 };
const SPEECH: StageSpeech = { voice: VOICE, rates: RATES };
/** The fake voice's pace at speed 1; it speaks `speed` times faster, as Kokoro roughly does. */
const NATURAL_WPM = 150;

/** Speaks every word for the same slot at its speed, spreading the words evenly; records every synthesis. */
function scriptedVoice(version = "fake/1") {
  const calls: { text: string; voice: string; speed: number | undefined }[] = [];
  const provider: TtsProvider = {
    id: "scripted",
    capabilities: { phonemeInput: [], wordTimestamps: true, speedControl: true, voices: [], languages: ["en-US"], sampleRate: RATE },
    synthesize: async (input, voice, options) => {
      const text = "text" in input ? input.text : "";
      calls.push({ text, voice, speed: options?.speed });
      const words = text.split(/\s+/);
      const seconds = (words.length * 60) / (NATURAL_WPM * (options?.speed ?? 1));
      const step = seconds / words.length;
      const audio = { samples: new Float32Array(Math.round(seconds * RATE)).fill(0.1), sampleRate: RATE };
      return { audio, durationS: seconds, words: words.map((word, i) => ({ word, start: i * step, end: (i + 1) * step })) };
    },
  };
  const engine = async (): Promise<TtsEngine> => ({ provider, version });
  return { engine, calls };
}

/** The fixture script with its first two beats given known text and planned lengths; the tests read those two. */
function twoBeats(): ScriptV1 {
  const script = choppy();
  const [first, second, ...rest] = script.beats;
  return { ...script, beats: [{ ...first!, plannedS: 5, spoken: "one two three four five six" }, { ...second!, plannedS: 4, spoken: "seven eight" }, ...rest] };
}

const [B1, B2] = twoBeats().beats.map((b) => b.id);

/** A `resolved` artifact giving B1 the concept band, B2 the code band and every other beat takeaways, unless `bands` says otherwise. */
function resolvedFor(script: ScriptV1, bands: Record<string, SpeechBand> = {}) {
  const band = (id: string): SpeechBand => bands[id] ?? (id === B1 ? "concept" : id === B2 ? "code" : "takeaways");
  const beats = script.beats.map((b) => ({
    id: b.id, chapter: b.chapter, key: { function: "WHAT", job: "numbers", content: "statement", route: "none" }, row: "r1", beat: "stat",
    component: { maturity: "shipped" }, band: band(b.id), framing: "full", layer: "template", anchors: [],
  }));
  return JSON.stringify({ schema: "explainer.resolved/v1", profile: script.profile, beats, budgets: [] });
}

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function harness(script: ScriptV1 = twoBeats(), bands: Record<string, SpeechBand> = {}) {
  root = mkdtempSync(path.join(tmpdir(), "explainer-tts-test-"));
  const db = openDatabase(path.join(root, "state.sqlite3"));
  runMigrations(db, [artifactMigration(1)]);
  const store = new ArtifactStore(root, db);
  const from = { runId: "r1", stage: "tts" };
  const artifacts = { script: store.putText(JSON.stringify(script), "script", from), resolved: store.putText(resolvedFor(script, bands), "resolved", from) };
  return { store, input: { artifacts, store, from }, takesDir: path.join(root, "takes") };
}

const Word = z.object({ word: z.string(), start: z.number(), end: z.number() });
const WordsFile = z.object({
  beats: z.array(z.object({ id: z.string(), startS: z.number(), durationS: z.number(), words: z.array(Word) })),
  absolute: z.array(Word.extend({ beat: z.string() })),
});
const WordsSchema = (text: string) => WordsFile.parse(JSON.parse(text));
const TreeFile = z.object({ entries: z.array(z.object({ path: z.string(), sha: z.string() })) });
const VoiceFile = z.object({ beats: z.array(z.object({ id: z.string(), band: z.string(), rateWpm: z.number(), speed: z.number(), wpm: z.number() })) });
const textsOf = (calls: readonly { text: string }[]): Set<string> => new Set(calls.map((c) => c.text));

describe("tts stage: duration truing and absolute words", () => {
  it("trues a beat after its band's rate is applied: six code words at 40 wpm run 9 s, so a 5 s slot becomes 10.2 s", async () => {
    const { store, input, takesDir } = harness(twoBeats(), { [B1!]: "code", [B2!]: "concept" });

    const outcome = await runTtsStage(input, SPEECH, { engine: scriptedVoice().engine, takesDir, padding: { leadS: 0.3, tailS: 0.9 } });

    const words = WordsSchema(store.readText(outcome.outputs.words!));
    expect(words.beats.slice(0, 2).map((b) => [b.id, b.startS, b.durationS])).toEqual([[B1, 0, 10.2], [B2, 10.2, 4]]);
    expect(words.beats[1]!.words[0]).toEqual({ word: "seven", start: 0.3, end: 0.8 });
    expect(words.absolute.filter((w) => w.beat === B2)).toEqual([
      { beat: B2, word: "seven", start: 10.5, end: 11 },
      { beat: B2, word: "eight", start: 11, end: 11.5 },
    ]);
  });

  it("keeps the planned length when the voice fits inside it, and rounds a longer one up to a whole frame", () => {
    expect(trueDuration(5, 2)).toBe(5);
    expect(trueDuration(5, 6.1)).toBe(7);
    expect(trueDuration(5, 6.11)).toBeCloseTo(7.0333, 4);
    expect(DEFAULT_PADDING).toEqual({ leadS: 0.3, tailS: 0.6 });
  });

  it("writes each beat's WAV with the lead's silence before the speech", async () => {
    const { store, input, takesDir } = harness();

    const outcome = await runTtsStage(input, SPEECH, { engine: scriptedVoice().engine, takesDir });

    const tree = TreeFile.parse(JSON.parse(store.readText(outcome.outputs.audio!)));
    const b2 = decodeWav(readFileSync(store.path(tree.entries.find((e) => e.path === `${B2}.wav`)!.sha)));
    expect(b2.samples.length).toBe(Math.round((DEFAULT_PADDING.leadS + 3) * RATE));
    expect(b2.samples[0]).toBe(0);
  });
});
describe("tts stage: per-beat rate and take cache", () => {
  it("voices each beat at its band's words a minute times the voice rate, and records them per beat in voice.json", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice();

    const outcome = await runTtsStage(input, { voice: { id: "am_eric", rate: 1.5, source: "profile repo-tour" }, rates: RATES }, { engine: voice.engine, takesDir });

    expect(new Set(voice.calls.map((c) => c.voice))).toEqual(new Set(["am_eric"]));
    const file = JSON.parse(store.readText(outcome.outputs.voice!));
    expect(file).toMatchObject({ schema: "explainer.voice/v2", provider: "scripted", engine: "fake/1", id: "am_eric", rate: 1.5, source: "profile repo-tour" });
    expect(VoiceFile.parse(file).beats.slice(0, 2)).toEqual([
      { id: B1, band: "concept", rateWpm: 180, speed: 1.2, wpm: 180 },
      { id: B2, band: "code", rateWpm: 60, speed: 0.4, wpm: 60 },
    ]);
  });

  it("refuses a script beat the resolved artifact gives no band, before any audio is made", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice();
    const partial = JSON.parse(resolvedFor(twoBeats()));
    partial.beats = partial.beats.filter((b: { id: string }) => b.id !== B2);
    const next = { ...input, artifacts: { ...input.artifacts, resolved: store.putText(JSON.stringify(partial), "resolved", input.from) } };

    await expect(runTtsStage(next, SPEECH, { engine: voice.engine, takesDir })).rejects.toThrow(`beat ${B2} has no band`);
    expect(voice.calls).toEqual([]);
  });

  it("voices no beat that resolve cut, and still voices the rest", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice();
    const partial = JSON.parse(resolvedFor(twoBeats()));
    partial.beats = partial.beats.filter((b: { id: string }) => b.id !== B2);
    partial.cut = [{ id: B2, chapter: "ch1", code: "E-SIM-MISS", detail: "synthetic miss" }];
    const next = { ...input, artifacts: { ...input.artifacts, resolved: store.putText(JSON.stringify(partial), "resolved", input.from) } };

    const outcome = await runTtsStage(next, SPEECH, { engine: voice.engine, takesDir });

    const voiced = WordsSchema(store.readText(outcome.outputs.words!)).beats.map((b) => b.id);
    expect(voiced).toContain(B1);
    expect(voiced).not.toContain(B2);
    expect(textsOf(voice.calls).has("seven eight")).toBe(false);
  });

  it("re-voices only the beat whose text changed, and keeps the untouched beat's audio byte for byte", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice();
    const first = await runTtsStage(input, SPEECH, { engine: voice.engine, takesDir });
    const voiced = voice.calls.length;
    const edited = twoBeats();
    edited.beats[1] = { ...edited.beats[1]!, spoken: "seven nine", plannedS: 3 };
    const next = { ...input, artifacts: { ...input.artifacts, script: store.putText(JSON.stringify(edited), "script", input.from) } };

    const second = await runTtsStage(next, SPEECH, { engine: voice.engine, takesDir });

    expect(textsOf(voice.calls.slice(voiced))).toEqual(new Set(["seven nine"]));
    const entries = (sha: string) => TreeFile.parse(JSON.parse(store.readText(sha))).entries.map((e) => e.sha);
    expect(entries(second.outputs.audio!)[0]).toBe(entries(first.outputs.audio!)[0]);
  });

  it("re-voices only the beat whose beat type moved it to another band", async () => {
    const { store, input, takesDir } = harness();
    await runTtsStage(input, SPEECH, { engine: scriptedVoice().engine, takesDir });
    const moved = { ...input, artifacts: { ...input.artifacts, resolved: store.putText(resolvedFor(twoBeats(), { [B2!]: "story" }), "resolved", input.from) } };
    const again = scriptedVoice();

    await runTtsStage(moved, SPEECH, { engine: again.engine, takesDir });

    expect(textsOf(again.calls)).toEqual(new Set(["seven eight"]));
  });

  it.each([
    ["voice", { ...SPEECH, voice: { ...VOICE, id: "am_eric" } }, "fake/1"],
    ["voice rate", { ...SPEECH, voice: { ...VOICE, rate: 1.2 } }, "fake/1"],
    ["band rates", { ...SPEECH, rates: { story: 190, concept: 130, code: 50, takeaways: 160, held: 160 } }, "fake/1"],
    ["engine version", SPEECH, "fake/2"],
  ])("misses the take cache for every beat when the %s changes", async (_what, speech, version) => {
    const { input, takesDir } = harness();
    await runTtsStage(input, SPEECH, { engine: scriptedVoice().engine, takesDir });
    const again = scriptedVoice(version);

    await runTtsStage(input, speech, { engine: again.engine, takesDir });

    expect(textsOf(again.calls)).toEqual(textsOf(twoBeats().beats.map((b) => ({ text: b.spoken }))));
  });
});

describe("tts stage: Kokoro strict words", () => {
  it("refuses a word Kokoro has no phonemes for before the model loads", async () => {
    const { provider } = await kokoroEngine();

    await expect(provider.synthesize({ text: "the zqxvbrt gate" }, "af_heart")).rejects.toBeInstanceOf(TtsUnknownWordsError);
  });
});

/** A Kokoro engine that records the phoneme string of every chunk and returns a short tone, so no model loads. */
function phonemeRecorder() {
  const phonemes: string[] = [];
  const engine: KokoroEngine = {
    tokenize(ps) {
      phonemes.push(ps);
      return [0, ...[...ps].map((_, k) => k + 1), 0];
    },
    voicePack: () => Promise.resolve(new Float32Array(510 * 256)),
    run: ({ ids }) => Promise.resolve({ waveform: new Float32Array(ids.length * 2 * 600).fill(0.1), durations: Float32Array.from(ids, () => 2) }),
    dispose: () => Promise.resolve(),
  };
  return { phonemes, loadEngine: () => Promise.resolve(engine) };
}

const ZQX_LEXICON: Lexicon = { schema: "lexicon.v1", entries: [{ term: "zqxbuild", phonemes: { misaki: "zˈikjubˌɪld" } }, { term: "respelt", respell: "rispelt" }] };

/** The two-beat fixture with the first beat speaking a word only the lexicon knows. */
function lexiconBeats(spoken = "we ship the zqxbuild today"): ScriptV1 {
  const script = twoBeats();
  return { ...script, beats: [{ ...script.beats[0]!, spoken }, ...script.beats.slice(1)] };
}

describe("tts stage: Kokoro lexicon", () => {
  it("voices a lexicon word with its misaki phonemes and keeps the word as written in words.json", async () => {
    const { store, input, takesDir } = harness(lexiconBeats());
    const recorder = phonemeRecorder();

    const outcome = await runTtsStage(input, SPEECH, { engine: () => kokoroEngine({ lexicon: ZQX_LEXICON, loadEngine: recorder.loadEngine }), takesDir });

    expect(recorder.phonemes.some((ps) => ps.includes("zˈikjubˌɪld"))).toBe(true);
    const words = WordsSchema(store.readText(outcome.outputs.words!));
    expect(words.beats[0]!.words.map((w) => w.word)).toContain("zqxbuild");
  });

  it("still refuses a word neither misaki nor the lexicon knows, before the model loads", async () => {
    const { input, takesDir } = harness(lexiconBeats("we ship the zqxbuild and zqxvbrt today"));
    const recorder = phonemeRecorder();

    const run = runTtsStage(input, SPEECH, { engine: () => kokoroEngine({ lexicon: ZQX_LEXICON, loadEngine: recorder.loadEngine }), takesDir });

    await expect(run).rejects.toBeInstanceOf(TtsUnknownWordsError);
    expect(recorder.phonemes).toEqual([]);
  });

  it("re-voices every take when the lexicon's phonemes change, and not for a respelling-only edit", async () => {
    const respellOnly: Lexicon = { ...ZQX_LEXICON, entries: [ZQX_LEXICON.entries[0]!] };
    const changed: Lexicon = { ...ZQX_LEXICON, entries: [{ term: "zqxbuild", phonemes: { misaki: "zˈækbˌɪld" } }] };

    const [base, same, other] = await Promise.all([ZQX_LEXICON, respellOnly, changed].map((lexicon) => kokoroEngine({ lexicon })));

    expect(same!.version).toBe(base!.version);
    expect(other!.version).not.toBe(base!.version);
  });

  it("voices ffmpeg from the doctrine lexicon", async () => {
    const recorder = phonemeRecorder();
    const { provider } = await kokoroEngine({ loadEngine: recorder.loadEngine });

    await provider.synthesize({ text: "we rebuilt ffmpeg" }, "af_heart");

    expect(recorder.phonemes.join(" ")).toMatch(/ɛf.*ɛf.*ɛm.*pˈɛɡ/);
  });
});
