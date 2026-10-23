import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeWav, TtsUnknownWordsError, type TtsProvider } from "@titan-design/speech-tts";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import type { ScriptV1 } from "../script-schema.js";
import { artifactMigration, ArtifactStore } from "./artifacts.js";
import { kokoroEngine } from "./tts-engine.js";
import { runTtsStage, type StageVoice, type TtsEngine } from "./tts-stage.js";
import { DEFAULT_PADDING, trueDuration } from "./tts-truing.js";

const RATE = 1000;
const VOICE: StageVoice = { id: "af_heart", rate: 1, source: "default" };

/** Speaks each beat for the seconds `lengths` gives its text, spreading the words evenly; records every synthesis. */
function scriptedVoice(lengths: Record<string, number>, version = "fake/1") {
  const calls: { text: string; voice: string; speed: number | undefined }[] = [];
  const provider: TtsProvider = {
    id: "scripted",
    capabilities: { phonemeInput: [], wordTimestamps: true, speedControl: true, voices: [], languages: ["en-US"], sampleRate: RATE },
    synthesize: async (input, voice, options) => {
      const text = "text" in input ? input.text : "";
      calls.push({ text, voice, speed: options?.speed });
      const seconds = lengths[text] ?? 1;
      const words = text.split(/\s+/);
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

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function harness(script: ScriptV1 = twoBeats()) {
  root = mkdtempSync(path.join(tmpdir(), "explainer-tts-test-"));
  const db = openDatabase(path.join(root, "state.sqlite3"));
  runMigrations(db, [artifactMigration(1)]);
  const store = new ArtifactStore(root, db);
  const from = { runId: "r1", stage: "tts" };
  const input = { artifacts: { script: store.putText(JSON.stringify(script), "script", from) }, store, from };
  return { store, input, takesDir: path.join(root, "takes") };
}

const Word = z.object({ word: z.string(), start: z.number(), end: z.number() });
const WordsFile = z.object({
  beats: z.array(z.object({ id: z.string(), startS: z.number(), durationS: z.number(), words: z.array(Word) })),
  absolute: z.array(Word.extend({ beat: z.string() })),
});
const WordsSchema = (text: string) => WordsFile.parse(JSON.parse(text));
const TreeFile = z.object({ entries: z.array(z.object({ path: z.string(), sha: z.string() })) });

describe("tts stage: duration truing and absolute words", () => {
  it("trues a 5 s planned beat whose voice runs 6.1 s to 7.3 s, and shifts the next beat's words by its start", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice({ "one two three four five six": 6.1, "seven eight": 2 });

    const outcome = await runTtsStage(input, VOICE, { engine: voice.engine, takesDir, padding: { leadS: 0.3, tailS: 0.9 } });

    const words = WordsSchema(store.readText(outcome.outputs.words!));
    expect(words.beats.slice(0, 2).map((b) => [b.id, b.startS, b.durationS])).toEqual([[B1, 0, 7.3], [B2, 7.3, 4]]);
    expect(words.beats[1]!.words[0]).toEqual({ word: "seven", start: 0.3, end: 1.3 });
    expect(words.absolute.filter((w) => w.beat === B2)).toEqual([
      { beat: B2, word: "seven", start: 7.6, end: 8.6 },
      { beat: B2, word: "eight", start: 8.6, end: 9.6 },
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
    const voice = scriptedVoice({ "one two three four five six": 6.1, "seven eight": 2 });

    const outcome = await runTtsStage(input, VOICE, { engine: voice.engine, takesDir });

    const tree = TreeFile.parse(JSON.parse(store.readText(outcome.outputs.audio!)));
    const b2 = decodeWav(readFileSync(store.path(tree.entries.find((e) => e.path === `${B2}.wav`)!.sha)));
    expect(b2.samples.length).toBe(Math.round((DEFAULT_PADDING.leadS + 2) * RATE));
    expect(b2.samples[0]).toBe(0);
  });
});

describe("tts stage: voice and take cache", () => {
  it("speaks in the stage's voice and rate, and writes them to voice.json", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice({});

    const outcome = await runTtsStage(input, { id: "am_eric", rate: 1.1, source: "profile repo-tour" }, { engine: voice.engine, takesDir });

    expect(new Set(voice.calls.map((c) => `${c.voice}@${c.speed}`))).toEqual(new Set(["am_eric@1.1"]));
    expect(JSON.parse(store.readText(outcome.outputs.voice!))).toEqual({
      schema: "explainer.voice/v1", provider: "scripted", engine: "fake/1", id: "am_eric", rate: 1.1, source: "profile repo-tour",
    });
  });

  it("re-voices only the beat whose text changed, and keeps the untouched beat's audio byte for byte", async () => {
    const { store, input, takesDir } = harness();
    const voice = scriptedVoice({});
    const first = await runTtsStage(input, VOICE, { engine: voice.engine, takesDir });
    const edited = twoBeats();
    edited.beats[1] = { ...edited.beats[1]!, spoken: "seven nine", plannedS: 3 };
    const next = { ...input, artifacts: { script: store.putText(JSON.stringify(edited), "script", input.from) } };

    const second = await runTtsStage(next, VOICE, { engine: voice.engine, takesDir });

    const beats = twoBeats().beats.length;
    expect(voice.calls).toHaveLength(beats + 1);
    expect(voice.calls.at(-1)!.text).toBe("seven nine");
    const entries = (sha: string) => TreeFile.parse(JSON.parse(store.readText(sha))).entries.map((e) => e.sha);
    expect(entries(second.outputs.audio!)[0]).toBe(entries(first.outputs.audio!)[0]);
  });

  it.each([
    ["voice", { ...VOICE, id: "am_eric" }, "fake/1"],
    ["rate", { ...VOICE, rate: 1.2 }, "fake/1"],
    ["engine version", VOICE, "fake/2"],
  ])("misses the take cache when the %s changes", async (_what, voice, version) => {
    const { input, takesDir } = harness();
    await runTtsStage(input, VOICE, { engine: scriptedVoice({}).engine, takesDir });
    const again = scriptedVoice({}, version);

    await runTtsStage(input, voice, { engine: again.engine, takesDir });

    expect(again.calls).toHaveLength(twoBeats().beats.length);
  });
});

describe("tts stage: Kokoro strict words", () => {
  it("refuses a word Kokoro has no phonemes for before the model loads", async () => {
    const { provider } = await kokoroEngine();

    await expect(provider.synthesize({ text: "the zqxvbrt gate" }, "af_heart")).rejects.toBeInstanceOf(TtsUnknownWordsError);
  });
});
