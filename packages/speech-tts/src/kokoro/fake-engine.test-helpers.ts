import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KokoroEngine } from "./engine.js";
import type { KokoroG2p } from "./provider.js";

const HOP = 600;
const STYLE_DIM = 256;
const PACK_ROWS = 510;
const MODEL_DIR = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";

/** A temp model cache holding (empty) copies of every file an fp32 load reads. The caller removes it. */
export function filledCache(files = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"]): string {
  const cacheDir = mkdtempSync(join(tmpdir(), "kokoro-cache-"));
  for (const file of files) {
    const path = join(cacheDir, MODEL_DIR, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  return cacheDir;
}

export interface FakeEngineOptions {
  /** Raw frames per id at speed 1; the fake divides by the speed. */
  framesPerId?: number;
  /** Samples left off the waveform, to break the frame-sum contract. */
  shortBy?: number;
  /** Phoneme characters the tokenizer silently drops, as Kokoro's vocab filter would. */
  drop?: string;
  /** `run` never settles. */
  hang?: boolean;
}

interface FakeEngine extends KokoroEngine {
  readonly tokenized: string[];
  readonly runs: { ids: readonly number[]; styleRow: number; speed: number }[];
}

/** Every pack row is filled with its own index, so a test can read back which row the engine got. */
export function indexedPack(rows = PACK_ROWS): Float32Array {
  return Float32Array.from({ length: rows * STYLE_DIM }, (_, k) => Math.floor(k / STYLE_DIM));
}

/** A tone the length the rounded frames promise, less `shortBy`. */
function waveformFor(frames: number, shortBy: number): Float32Array {
  return Float32Array.from({ length: frames * HOP - shortBy }, (_, n) => 0.1 * Math.sin((2 * Math.PI * 220 * n) / 24_000));
}

export function fakeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  const tokenized: string[] = [];
  const runs: FakeEngine["runs"] = [];
  const kept = (ps: string): string[] => [...ps].filter((ch) => !opts.drop?.includes(ch));
  return {
    tokenized,
    runs,
    tokenize(ps) {
      tokenized.push(ps);
      return [0, ...kept(ps).map((_, k) => k + 1), 0];
    },
    voicePack: () => Promise.resolve(indexedPack()),
    run({ ids, style, speed }) {
      runs.push({ ids, styleRow: style[0] ?? -1, speed });
      if (opts.hang) return new Promise(() => undefined);
      const durations = Float32Array.from(ids, () => (opts.framesPerId ?? 2) / speed);
      const frames = durations.reduce((sum, d) => sum + Math.max(1, Math.round(d)), 0);
      return Promise.resolve({ waveform: waveformFor(frames, opts.shortBy ?? 0), durations });
    },
    dispose: () => Promise.resolve(),
  };
}

/** Reads each word as its own letters, so a test knows every phoneme count. */
export function letterG2p(): KokoroG2p & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tokens(text) {
      calls.push(text);
      const words = text.split(/\s+/).filter(Boolean);
      return words.map((word, k) => ({ text: word, phonemes: word.toLowerCase(), whitespace: k < words.length - 1 ? " " : "" }));
    },
  };
}
