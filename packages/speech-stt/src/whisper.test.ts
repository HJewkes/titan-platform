import { describe, expect, it, vi } from "vitest";
import type { Audio } from "./schemas.js";
import { loadTransformersPipeline, whisperStt, type AsrChunk, type AsrFactory, type AsrOutput } from "./whisper.js";

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

function fakeAsr(output: AsrOutput = SPLIT_WORD_OUTPUT) {
  const asr = Object.assign(
    vi.fn(async (_samples: Float32Array, _options: unknown) => output),
    { dispose: vi.fn(async () => undefined) },
  );
  const factory = vi.fn(async () => asr);
  return { asr, factory, loadPipeline: vi.fn(async () => factory as unknown as AsrFactory) };
}

const tone = (n: number, sampleRate = 16000): Audio => ({
  samples: Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5),
  sampleRate,
});

describe("whisperStt", () => {
  it("merges sub-word chunks into whole words timed in seconds", async () => {
    const { loadPipeline } = fakeAsr();
    const transcript = await whisperStt({ loadPipeline }).transcribe(tone(1600));

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
      .mockResolvedValue(factory as unknown as AsrFactory);
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

  it("returns the module's pipeline", async () => {
    const pipeline = vi.fn();
    await expect(loadTransformersPipeline(async () => ({ pipeline }))).resolves.toBe(pipeline);
  });
});
