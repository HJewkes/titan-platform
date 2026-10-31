import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageDir } from "../package-dir.js";

const TRANSFORMERS_PEER = "@huggingface/transformers";
const VOICES_PEER = "kokoro-js";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";
// The files an fp32 load reads; a cache holding only another precision must not pass the offline guard.
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"];
const STYLE_DIM = 256;

/** The model behind `kokoroProvider`, which loads the real fp32 one unless given a `loadEngine`. */
export interface KokoroEngine {
  /** Kokoro's input ids for one chunk's phonemes, `<bos>` and `<eos>` included. */
  tokenize(ps: string): number[];
  /** A voice's style pack: rows of 256 floats, one per phoneme count. */
  voicePack(voice: string): Promise<Float32Array>;
  /** One forward pass. `durations` are the unrounded frames per id. */
  run(input: { ids: readonly number[]; style: Float32Array; speed: number }, signal: AbortSignal): Promise<{ waveform: Float32Array; durations: Float32Array }>;
  dispose(): Promise<void>;
}

type ModuleImporter = (name: string) => Promise<unknown>;

export interface KokoroEngineOptions {
  /** Where transformers.js caches the model. Its default sits inside node_modules, so products pass one. */
  cacheDir?: string;
  device: string;
  /** Injectable for tests; defaults to a dynamic import. */
  importModule?: ModuleImporter;
  /** Where the `<voice>.bin` packs live; defaults to the kokoro-js peer's `voices/`. */
  voicesDir?: string;
}

interface TensorLike {
  data: ArrayLike<number | bigint>;
}
type TensorCtor = new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => unknown;
type KokoroModel = ((inputs: Record<string, unknown>) => Promise<Record<string, TensorLike>>) & { dispose(): Promise<unknown> };
type KokoroTokenizer = (text: string, options: { truncation: boolean }) => { input_ids: TensorLike };
interface Pretrained<T> {
  from_pretrained(model: string, options: Record<string, unknown>): Promise<T>;
}
interface KokoroRuntime {
  StyleTextToSpeech2Model: Pretrained<KokoroModel>;
  AutoTokenizer: Pretrained<KokoroTokenizer>;
  Tensor: TensorCtor;
}

const isObjectOrFunction = (v: unknown): v is Record<string, unknown> => (typeof v === "object" || typeof v === "function") && v !== null;
const hasPretrained = (v: unknown): boolean => isObjectOrFunction(v) && typeof v.from_pretrained === "function";

// Only the shape is checked here; the opt-in smoke test proves the real classes behave.
function isKokoroRuntime(mod: unknown): mod is KokoroRuntime {
  return isObjectOrFunction(mod) && hasPretrained(mod.StyleTextToSpeech2Model) && hasPretrained(mod.AutoTokenizer) && typeof mod.Tensor === "function";
}

/** With TITAN_SPEECH_OFFLINE set, a model not fully cached is refused before the peer can reach the network. */
function assertCachedWhenOffline(cacheDir: string | undefined): void {
  if (!process.env.TITAN_SPEECH_OFFLINE) return;
  if (cacheDir === undefined) throw new Error(`offline: TITAN_SPEECH_OFFLINE is set and no cacheDir is given for ${MODEL}`);
  const missing = MODEL_FILES.filter((file) => !existsSync(join(cacheDir, MODEL, file)));
  if (missing.length > 0) throw new Error(`offline: ${MODEL} (${missing.join(", ")}) is not in ${cacheDir} and TITAN_SPEECH_OFFLINE is set`);
}

async function importRuntime(importModule: ModuleImporter): Promise<KokoroRuntime> {
  let mod: unknown;
  try {
    mod = await importModule(TRANSFORMERS_PEER);
  } catch (cause) {
    throw new Error(`${TRANSFORMERS_PEER} is not installed; run \`npm i ${TRANSFORMERS_PEER} ${VOICES_PEER}\` to use Kokoro`, { cause });
  }
  if (!isKokoroRuntime(mod)) throw new Error(`Kokoro needs ${TRANSFORMERS_PEER} 3.8.1 or later (no StyleTextToSpeech2Model found)`);
  return mod;
}

// kokoro-js ships its packs as data beside its code; its exports map hides them, so walk up from the entry.
function kokoroJsVoicesDir(): string {
  return join(packageDir(VOICES_PEER, import.meta.url), "voices");
}

/** Reads `<voicesDir>/<voice>.bin`: float32 rows of 256, as kokoro-js ships them. */
async function loadVoicePack(voice: string, voicesDir: string | undefined): Promise<Float32Array> {
  const bytes = await readFile(join(voicesDir ?? kokoroJsVoicesDir(), `${voice}.bin`));
  if (bytes.byteLength === 0 || bytes.byteLength % (STYLE_DIM * 4) !== 0) {
    throw new Error(`voice pack ${voice}.bin holds ${bytes.byteLength} bytes, not whole rows of ${STYLE_DIM} floats`);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}

function engineOver(runtime: KokoroRuntime, model: KokoroModel, tokenizer: KokoroTokenizer, voicesDir: string | undefined): KokoroEngine {
  const packs = new Map<string, Promise<Float32Array>>();
  return {
    tokenize: (ps) => Array.from(tokenizer(ps, { truncation: true }).input_ids.data, Number),
    voicePack(voice) {
      const pack = packs.get(voice) ?? loadVoicePack(voice, voicesDir);
      packs.set(voice, pack);
      pack.catch(() => packs.delete(voice));
      return pack;
    },
    async run({ ids, style, speed }, signal) {
      signal.throwIfAborted();
      const outputs = await model({
        input_ids: new runtime.Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
        style: new runtime.Tensor("float32", style, [1, STYLE_DIM]),
        speed: new runtime.Tensor("float32", [speed], [1]),
      });
      const durationsName = Object.keys(outputs).find((name) => name !== "waveform");
      const waveform = outputs.waveform;
      const durations = durationsName === undefined ? undefined : outputs[durationsName];
      if (!waveform || !durations) throw new Error(`Kokoro returned ${Object.keys(outputs).join(", ")}, not a waveform and durations`);
      return { waveform: Float32Array.from(waveform.data, Number), durations: Float32Array.from(durations.data, Number) };
    },
    async dispose() {
      await model.dispose();
    },
  };
}

/** Loads Kokoro at fp32 through the optional transformers.js peer. fp32 only: q8f16 shifts durations (E7). */
export async function loadKokoroEngine(options: KokoroEngineOptions): Promise<KokoroEngine> {
  assertCachedWhenOffline(options.cacheDir);
  const runtime = await importRuntime(options.importModule ?? ((name) => import(name)));
  const cache = options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir };
  const model = await runtime.StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: "fp32", device: options.device, ...cache });
  const tokenizer = await runtime.AutoTokenizer.from_pretrained(MODEL, cache);
  return engineOver(runtime, model, tokenizer, options.voicesDir);
}
