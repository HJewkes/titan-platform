import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCachedWhenOffline, loadTransformersModule } from "./transformers-loader.js";
import { loadTransformersCtc, WAV2VEC2_MODEL } from "./wav2vec2.js";

const MODEL = "org/model";

function cacheHolding(...files: string[]): string {
  const cacheDir = mkdtempSync(join(tmpdir(), "speech-cache-"));
  for (const file of files) {
    mkdirSync(dirname(join(cacheDir, file)), { recursive: true });
    writeFileSync(join(cacheDir, file), "");
  }
  return cacheDir;
}

describe("assertCachedWhenOffline with a required file", () => {
  let cacheDir = "";
  beforeEach(() => vi.stubEnv("TITAN_SPEECH_OFFLINE", "1"));
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("refuses a q8 request when only the fp32 weights are cached, naming the missing file", () => {
    cacheDir = cacheHolding(`${MODEL}/onnx/model.onnx`, `${MODEL}/config.json`);

    expect(() => assertCachedWhenOffline(MODEL, cacheDir, { file: "onnx/model_quantized.onnx" })).toThrow(
      /^offline: org\/model \(onnx\/model_quantized\.onnx\) is not in/,
    );
    expect(() => assertCachedWhenOffline(MODEL, cacheDir, { file: "onnx/model.onnx" })).not.toThrow();
  });

  it("looks for a pinned revision under its own directory, as transformers.js caches it", () => {
    cacheDir = cacheHolding(`${MODEL}/onnx/model.onnx`, `${MODEL}/abc123/onnx/model.onnx`);

    expect(() => assertCachedWhenOffline(MODEL, cacheDir, { file: "onnx/model.onnx", revision: "abc123" })).not.toThrow();
    expect(() => assertCachedWhenOffline(MODEL, cacheDir, { file: "onnx/model.onnx", revision: "def456" })).toThrow(/^offline:/);
    expect(() => assertCachedWhenOffline(MODEL, cacheDir, { file: "onnx/model.onnx", revision: "main" })).not.toThrow();
  });

  it("does nothing when TITAN_SPEECH_OFFLINE is unset", () => {
    vi.stubEnv("TITAN_SPEECH_OFFLINE", "");
    cacheDir = cacheHolding();

    expect(() => assertCachedWhenOffline(MODEL, cacheDir, { file: "onnx/model.onnx" })).not.toThrow();
  });
});

describe("loadTransformersCtc offline", () => {
  it("throws offline: for an uncached q8 request before from_pretrained runs", async () => {
    const cacheDir = cacheHolding(`${WAV2VEC2_MODEL}/rev1/onnx/model.onnx`);
    const from_pretrained = vi.fn();
    vi.stubEnv("TITAN_SPEECH_OFFLINE", "1");
    try {
      const AutoModelForCTC = Object.assign(function AutoModelForCTC() {}, { from_pretrained });
      const factory = await loadTransformersCtc(async () => ({ AutoModelForCTC, Tensor: class {} }));
      await expect(factory(WAV2VEC2_MODEL, { dtype: "q8", cache_dir: cacheDir, revision: "rev1" })).rejects.toThrow(
        /^offline: .*model_quantized\.onnx/,
      );
      expect(from_pretrained).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("loadTransformersModule", () => {
  it("names the feature and the install command when the peer is missing", async () => {
    const missing = () => Promise.reject(new Error("Cannot find package"));

    await expect(loadTransformersModule(missing, "wav2vec2Recognizer")).rejects.toThrow(
      "run `npm i @huggingface/transformers` to use wav2vec2Recognizer",
    );
  });
});
