import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsUnavailableError } from "../errors.js";
import { loadKokoroEngine } from "./engine.js";
import { filledCache, indexedPack, letterG2p } from "./fake-engine.test-helpers.js";
import { kokoroProvider } from "./provider.js";

const HOP = 600;

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: ArrayLike<number | bigint>,
    readonly dims: number[],
  ) {}
}

/** The slice of @huggingface/transformers the loader touches: 2 frames per id, and a waveform to match. */
function fakeTransformers() {
  const model = Object.assign(
    (inputs: { input_ids: FakeTensor }) => {
      const n = inputs.input_ids.data.length;
      return Promise.resolve({ waveform: new FakeTensor("float32", new Float32Array(n * 2 * HOP), [1, n * 2 * HOP]), durations: new FakeTensor("float32", new Float32Array(n).fill(2), [n]) });
    },
    { dispose: () => Promise.resolve() },
  );
  const tokenizer = (text: string) => ({ input_ids: new FakeTensor("int64", BigInt64Array.from([0, ...[...text].map(() => 1), 0], BigInt), []) });
  const loads = vi.fn((_model: string, _options: Record<string, unknown>) => Promise.resolve(model));
  return {
    loads,
    module: { StyleTextToSpeech2Model: { from_pretrained: loads }, AutoTokenizer: { from_pretrained: () => Promise.resolve(tokenizer) }, Tensor: FakeTensor },
  };
}

const temps: string[] = [];
const temp = (dir: string): string => (temps.push(dir), dir);

function voicesDir(): string {
  const dir = temp(mkdtempSync(join(tmpdir(), "kokoro-voices-")));
  writeFileSync(join(dir, "af_heart.bin"), new Uint8Array(indexedPack(20).buffer));
  return dir;
}

function providerOver(cacheDir: string, importModule: (name: string) => Promise<unknown>) {
  const dir = voicesDir();
  return kokoroProvider({ g2p: letterG2p(), cacheDir, onWarning: () => undefined, loadEngine: (o) => loadKokoroEngine({ ...o, importModule, voicesDir: dir }) });
}

beforeEach(() => vi.stubEnv("TITAN_SPEECH_OFFLINE", "1"));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadKokoroEngine", () => {
  // Mutation caught: the guard runs after the import, so an offline run can still reach the network.
  it("refuses an uncached model offline before touching the peer", async () => {
    const importModule = vi.fn(() => Promise.resolve(fakeTransformers().module));
    const provider = providerOver(temp(mkdtempSync(join(tmpdir(), "kokoro-empty-"))), importModule);

    const call = provider.synthesize({ text: "hello" }, "af_heart");

    await expect(call).rejects.toBeInstanceOf(TtsUnavailableError);
    await expect(call).rejects.toThrow(/offline: .*onnx\/model\.onnx/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("refuses a cache holding only part of the fp32 files", async () => {
    const importModule = vi.fn(() => Promise.resolve(fakeTransformers().module));

    const load = loadKokoroEngine({ device: "cpu", cacheDir: temp(filledCache(["config.json"])), importModule });

    await expect(load).rejects.toThrow(/tokenizer\.json, tokenizer_config\.json, onnx\/model\.onnx\) is not in/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("loads the cached model once, at fp32 on the requested device, and synthesizes", async () => {
    const runtime = fakeTransformers();
    const importModule = vi.fn(() => Promise.resolve(runtime.module));
    const cacheDir = temp(filledCache());
    const provider = providerOver(cacheDir, importModule);

    await provider.synthesize({ text: "hello" }, "af_heart");
    const second = await provider.synthesize({ text: "there" }, "af_heart");

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(runtime.loads).toHaveBeenCalledWith("onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", { dtype: "fp32", device: "cpu", cache_dir: cacheDir });
    expect(second.audio.samples.length).toBe(7 * 2 * HOP);
  });

  // Mutation caught: the failed load promise is cached, so one missing install wedges the provider for good.
  it("retries a failed load on the next call", async () => {
    const runtime = fakeTransformers();
    const importModule = vi.fn().mockRejectedValueOnce(new Error("Cannot find package")).mockResolvedValue(runtime.module);
    const provider = providerOver(temp(filledCache()), importModule);

    await expect(provider.synthesize({ text: "hello" }, "af_heart")).rejects.toThrow(/npm i @huggingface\/transformers kokoro-js/);
    await expect(provider.synthesize({ text: "hello" }, "af_heart")).resolves.toBeDefined();

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("names the transformers version it needs when the peer predates Kokoro", async () => {
    const load = loadKokoroEngine({ device: "cpu", cacheDir: temp(filledCache()), importModule: () => Promise.resolve({ Tensor: FakeTensor }) });

    await expect(load).rejects.toThrow(/3\.8\.1 or later/);
  });
});
