import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { audioKey } from "./audio-key.js";
import type { Audio, Transcript } from "./schemas.js";
import {
  loadTransformersPipeline,
  whisperStt,
  type AsrChunk,
  type AsrFactory,
  type AsrOutput,
  type AsrPipeline,
  type SttProvider,
} from "./whisper.js";

const chunk = (text: string, start: number, end: number | null): AsrChunk => ({ text, timestamp: [start, end] });

// Whisper splits a rare word into sub-word chunks; only the first of them carries the leading space.
const SPLIT_WORD_OUTPUT: AsrOutput = {
  text: " Litestream replicates the database.",
  chunks: [
    chunk(" Lite", 0.32, 0.6),
    chunk("str", 0.6, 0.74),
    chunk("eam", 0.74, 0.9),
    chunk(" replicates", 0.9, 1.5),
    chunk(" the", 1.5, 1.62),
    chunk(" data", 1.62, 1.9),
    chunk("base.", 1.9, null),
  ],
};

// A toy vocabulary: ids below EOT (20) are text, 21 and 22 are the prompt's special tokens.
const EOT = 20;
const VOCAB = 23;
const PROMPT = [21, 22];
const PIECES: Record<number, string> = {
  0: " Lite",
  1: "str",
  2: "eam",
  3: " replicates",
  4: " the",
  5: " data",
  6: "base",
  7: ".",
  8: " zorptrix",
  9: " hummed",
  [EOT]: "<|endoftext|>",
  21: "<|startoftranscript|>",
  22: "<|notimestamps|>",
};
const decode = (ids: number[]) => ids.map((id) => PIECES[id]!).join("");
const LN3 = Math.log(3);

/** One greedy step: the chosen id and its probability, which two live logits (0 and ln 3) make derivable by hand. */
type Step = [id: number, p: 1 | 0.75 | 0.25];

function stepRow([id, p]: Step): Float32Array {
  const data = new Float32Array(VOCAB).fill(-Infinity);
  data[id] = p === 0.75 ? LN3 : 0;
  if (p !== 1) data[id === 0 ? 1 : 0] = p === 0.25 ? LN3 : 0;
  return data;
}

type LogitsProcessors = NonNullable<Parameters<AsrPipeline>[1]["logits_processor"]>;

/** One decode window as transformers.js runs it: generate appends a processor, then every step calls them all in order. */
function playWindow(processors: LogitsProcessors, steps: Step[]): void {
  processors.push((_ids, logits) => logits);
  steps.forEach((step, i) => {
    const ids = [...PROMPT, ...steps.slice(0, i).map(([id]) => id)];
    const logits = [{ data: stepRow(step) }];
    for (const processor of processors) processor([ids], logits);
  });
}

// Litestream (0.75, 0.25, 1) averages 2/3; database (0.75, 0.25) averages 1/2; "." stays out of every word.
const SPLIT_WORD_STEPS: Step[][] = [
  [[0, 0.75], [1, 0.25], [2, 1], [3, 1], [4, 0.75], [5, 0.75], [6, 0.25], [7, 0.25], [EOT, 1]],
];

function fakeAsr(output: AsrOutput = SPLIT_WORD_OUTPUT, windows: Step[][] = SPLIT_WORD_STEPS) {
  const processorCounts: number[] = [];
  const asr = Object.assign(
    vi.fn(async (_samples: Float32Array, options: Parameters<AsrPipeline>[1]) => {
      const processors = options.logits_processor;
      if (processors) processorCounts.push(processors.length);
      if (processors) windows.forEach((steps) => playWindow(processors, steps));
      return output;
    }),
    {
      dispose: vi.fn(async () => undefined),
      tokenizer: { decode },
      model: { generation_config: { eos_token_id: EOT } },
    },
  );
  const factory = vi.fn<AsrFactory>(async () => asr);
  return { asr, factory, loadPipeline: vi.fn(async () => factory), processorCounts };
}

const tone = (n: number, sampleRate = 16000): Audio => ({
  samples: Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5),
  sampleRate,
});

const probabilities = (transcript: Transcript) => transcript.words.map((w) => w.probability);

describe("whisperStt capabilities", () => {
  // Mutation caught: hard-coding capabilities: { tokenLogprobs: false }.
  it("declares token log-probs by default without loading the pipeline", () => {
    const { loadPipeline } = fakeAsr();

    expect(whisperStt({ loadPipeline }).capabilities.tokenLogprobs).toBe(true);
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it("declares none when opted out, without loading the pipeline", () => {
    const { loadPipeline } = fakeAsr();

    expect(whisperStt({ tokenLogprobs: false, loadPipeline }).capabilities.tokenLogprobs).toBe(false);
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it("returns words without probability and no segments when opted out, passing no logits processor", async () => {
    const { asr, loadPipeline } = fakeAsr();
    const transcript = await whisperStt({ tokenLogprobs: false, loadPipeline }).transcribe(tone(1600));

    expect(transcript.segments).toEqual([]);
    expect(transcript.words.every((w) => !("probability" in w))).toBe(true);
    expect(asr.mock.calls[0]?.[1]).not.toHaveProperty("logits_processor");
  });

  it("requires every provider to declare capabilities", () => {
    // @ts-expect-error capabilities is required on SttProvider
    const missing: SttProvider = { transcribe: async () => ({ text: "", words: [], segments: [] }) };

    expect(missing).toBeDefined();
  });
});

describe("whisperStt token log-probs", () => {
  it("gives each word the mean of its text tokens' probabilities and one segment for the window", async () => {
    const { loadPipeline } = fakeAsr();
    const transcript = await whisperStt({ loadPipeline }).transcribe(tone(1600));
    const bytes = Buffer.from("Litestream replicates the database.", "utf8");

    // Float32 holds ln 3 to about 1e-8, so the probabilities are close rather than exact.
    [2 / 3, 1, 0.75, 0.5].forEach((p, i) => expect(probabilities(transcript)[i]).toBeCloseTo(p, 6));
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0]).toMatchObject({ text: "Litestream replicates the database.", start: 0, end: 0.1 });
    expect(transcript.segments[0]!.avgLogprob).toBeCloseTo((Math.log(0.75) + Math.log(0.25)) / 3, 6);
    expect(transcript.segments[0]!.compressionRatio).toBe(bytes.length / deflateSync(bytes).length);
  });

  it("maps overlapping windows onto the merged words and spans each window's 30 s", async () => {
    const output: AsrOutput = {
      text: " the zorptrix hummed softly",
      chunks: [chunk(" the", 0, 1), chunk(" zorptrix", 1, 22), chunk(" hummed", 22, 40), chunk(" softly", 40, 44)],
    };
    const windows: Step[][] = [
      [[4, 0.75], [8, 0.25], [EOT, 1]],
      [[8, 1], [9, 0.75], [EOT, 1]],
    ];
    const { loadPipeline } = fakeAsr(output, windows);

    const transcript = await whisperStt({ loadPipeline }).transcribe(tone(16000 * 45));

    // "zorptrix" is in both windows; the matcher takes the first window's, as CPython's difflib would.
    [0.75, 0.25, 0.75].forEach((p, i) => expect(probabilities(transcript)[i]).toBeCloseTo(p, 6));
    expect(transcript.words[3]).not.toHaveProperty("probability");
    expect(transcript.segments.map(({ text, start, end }) => ({ text, start, end }))).toEqual([
      { text: "the zorptrix", start: 0, end: 30 },
      { text: "zorptrix hummed", start: 20, end: 45 },
    ]);
  });

  // Mutation caught: one processor array shared by every call, which Whisper's generate grows on each window.
  it("passes a fresh processor array on every call", async () => {
    const { loadPipeline, processorCounts } = fakeAsr();
    const stt = whisperStt({ loadPipeline });

    await stt.transcribe(tone(160));
    await stt.transcribe(tone(320));

    expect(processorCounts).toEqual([1, 1]);
  });

  it("rejects a pipeline without a tokenizer, naming the opt-out", async () => {
    const { asr, loadPipeline } = fakeAsr();
    Reflect.deleteProperty(asr, "tokenizer");

    await expect(whisperStt({ loadPipeline }).transcribe(tone(160))).rejects.toThrow("tokenLogprobs: false");
  });

  it("rejects a pipeline that never calls the processor, naming the verified transformers.js", async () => {
    const { loadPipeline } = fakeAsr(SPLIT_WORD_OUTPUT, []);

    await expect(whisperStt({ loadPipeline }).transcribe(tone(160))).rejects.toThrow("@huggingface/transformers 3.8.1");
  });

  it("keys the cache apart per mode, leaving the opted-out key as it was", async () => {
    const { asr, loadPipeline } = fakeAsr();
    const cache = new Map<string, Transcript>();
    const audio = tone(1600);

    await whisperStt({ cache, loadPipeline }).transcribe(audio);
    await whisperStt({ cache, tokenLogprobs: false, loadPipeline }).transcribe(audio);

    expect(asr).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    expect(cache.has(audioKey("onnx-community/whisper-base.en_timestamped", audio))).toBe(true);
  });
});

describe("whisperStt", () => {
  it("merges sub-word chunks into whole words timed in seconds", async () => {
    const { loadPipeline } = fakeAsr();
    const transcript = await whisperStt({ tokenLogprobs: false, loadPipeline }).transcribe(tone(1600));

    expect(transcript.text).toBe("Litestream replicates the database.");
    expect(transcript.words).toEqual([
      { text: "Litestream", start: 0.32, end: 0.9 },
      { text: "replicates", start: 0.9, end: 1.5 },
      { text: "the", start: 1.5, end: 1.62 },
      { text: "database.", start: 1.62, end: 1.9 },
    ]);
    expect(transcript.segments).toEqual([]);
  });

  it("makes no recognizer call for audio it has already transcribed", async () => {
    const { asr, loadPipeline } = fakeAsr();
    const stt = whisperStt({ loadPipeline });

    const first = await stt.transcribe(tone(1600));
    const second = await stt.transcribe(tone(1600));

    expect(asr).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("transcribes again when one sample changes", async () => {
    const { asr, loadPipeline } = fakeAsr();
    const stt = whisperStt({ loadPipeline });
    const edited = tone(1600);
    edited.samples[800] = 0.25;

    await stt.transcribe(tone(1600));
    await stt.transcribe(edited);

    expect(asr).toHaveBeenCalledTimes(2);
  });

  it("passes model, dtype, device and cacheDir to the pipeline", async () => {
    const { factory, loadPipeline } = fakeAsr();
    const stt = whisperStt({ model: "org/whisper-x", dtype: "q8", device: "cpu", cacheDir: "/models", loadPipeline });

    await stt.transcribe(tone(160));

    expect(factory).toHaveBeenCalledWith("automatic-speech-recognition", "org/whisper-x", {
      dtype: "q8",
      device: "cpu",
      cache_dir: "/models",
    });
  });

  it("resamples audio to 16 kHz before recognition", async () => {
    const { asr, loadPipeline } = fakeAsr();

    await whisperStt({ loadPipeline }).transcribe(tone(2400, 24000));

    expect(asr.mock.calls[0]?.[0]).toHaveLength(1600);
  });

  it("loads the pipeline once and disposes it", async () => {
    const { asr, loadPipeline } = fakeAsr();
    const stt = whisperStt({ loadPipeline });

    await stt.transcribe(tone(160));
    await stt.transcribe(tone(320));
    await stt.dispose();

    expect(loadPipeline).toHaveBeenCalledTimes(1);
    expect(asr.dispose).toHaveBeenCalledTimes(1);
  });

  it("retries the load after a failed one", async () => {
    const { factory } = fakeAsr();
    const loadPipeline = vi
      .fn<() => Promise<AsrFactory>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(factory);
    const stt = whisperStt({ loadPipeline });

    await expect(stt.transcribe(tone(160))).rejects.toThrow("offline");
    await expect(stt.transcribe(tone(160))).resolves.toMatchObject({ text: "Litestream replicates the database." });
  });
});

describe("loadTransformersPipeline", () => {
  it("names the install command when the peer is missing", async () => {
    const missing = () => Promise.reject(new Error("Cannot find package '@huggingface/transformers'"));

    await expect(loadTransformersPipeline(missing)).rejects.toThrow("npm i @huggingface/transformers");
    await expect(whisperStt({ loadPipeline: () => loadTransformersPipeline(missing) }).transcribe(tone(160))).rejects.toThrow(
      "npm i @huggingface/transformers",
    );
  });

  it("rejects a module without a pipeline export", async () => {
    await expect(loadTransformersPipeline(async () => ({}))).rejects.toThrow("npm i @huggingface/transformers");
  });

  it("returns a factory that calls the module's pipeline", async () => {
    const asr: AsrPipeline = Object.assign(async () => ({ text: "" }), { dispose: async () => {} });
    const pipeline = vi.fn(async () => asr);
    vi.stubEnv("TITAN_SPEECH_OFFLINE", "");
    const factory = await loadTransformersPipeline(async () => ({ pipeline }));

    const result = await factory("automatic-speech-recognition", "m", { dtype: "fp32" });

    expect(result).toBe(asr);
    expect(pipeline).toHaveBeenCalledWith("automatic-speech-recognition", "m", { dtype: "fp32" });
    vi.unstubAllEnvs();
  });
});

describe("offline guard", () => {
  const MODEL = "org/model";
  async function offlineFactory(cacheDir: string, pipeline: AsrFactory) {
    vi.stubEnv("TITAN_SPEECH_OFFLINE", "1");
    const factory = await loadTransformersPipeline(async () => ({ pipeline }));
    return factory("automatic-speech-recognition", MODEL, { dtype: "fp32", cache_dir: cacheDir });
  }

  it("passes when the model is cached", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "speech-cache-"));
    mkdirSync(join(cacheDir, MODEL), { recursive: true });
    writeFileSync(join(cacheDir, MODEL, "config.json"), "{}");
    const asr: AsrPipeline = Object.assign(async () => ({ text: "" }), { dispose: async () => {} });
    try {
      await expect(offlineFactory(cacheDir, async () => asr)).resolves.toBe(asr);
    } finally {
      vi.unstubAllEnvs();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("throws offline: when the model dir exists but is empty", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "speech-cache-"));
    mkdirSync(join(cacheDir, MODEL), { recursive: true });
    const pipeline = vi.fn<AsrFactory>();
    try {
      await expect(offlineFactory(cacheDir, pipeline)).rejects.toThrow(/^offline:/);
      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("throws offline: and never fetches when the cache is empty", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "speech-cache-"));
    const fetchFake = vi.fn();
    const factory: AsrFactory = async () => {
      await fetchFake("https://huggingface.co/model");
      throw new Error("the factory must not run offline");
    };
    vi.stubEnv("TITAN_SPEECH_OFFLINE", "1");
    try {
      const stt = whisperStt({
        cacheDir,
        loadPipeline: () => loadTransformersPipeline(async () => ({ pipeline: factory })),
      });

      await expect(stt.transcribe(tone(160))).rejects.toThrow(/^offline:/);
      expect(fetchFake).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
