import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignWords,
  resample,
  tokenizeIpa,
  wav2vec2Recognizer,
  type Audio,
  type Wav2vec2Dtype,
  type Word,
} from "@titan-design/speech-stt";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { espeakCliG2p, espeakVersion } from "./espeak-g2p.js";
import { DEFAULT_PHONE_VOICE } from "./phones.js";

// Opt-in evidence that `alignWords` reproduces the E2 spike's CTC aligner and meets the start-error bar. The inputs
// are owner-authored beats and third-party chunks, so they live outside the repo; no text or timing from them
// appears in this file, and the test prints aggregates only.
//
//   SPEECH_ALIGN_SMOKE_CACHE  a cacheDir already holding the pinned weights (vitest forces TITAN_SPEECH_OFFLINE)
//   SPEECH_ALIGN_E2_DIR       E2's e1-e2/results dir: manifest.json, ids_*.json, kokoro_ref.json, raw/*.json
//   SPEECH_ALIGN_DTYPE        q8 (default) or fp32
//   SPEECH_ALIGN_XTTS=1       also align the AB chunks against the Qwen3 reference; printed, never gated
const cacheDir = process.env.SPEECH_ALIGN_SMOKE_CACHE ?? "";
const e2Dir = process.env.SPEECH_ALIGN_E2_DIR ?? "";
const withXtts = process.env.SPEECH_ALIGN_XTTS === "1";
const dtype: Wav2vec2Dtype = process.env.SPEECH_ALIGN_DTYPE === "fp32" ? "fp32" : "q8";

// D-T14-1 is open. Working default: starts only, Kokoro gated, XTTS reported. A different owner answer is a change here.
const START_MEDIAN_BAR_MS = 33;
const START_P95_BAR_MS = 67;
const PARITY_MIN_SHARE = 0.95;
const PARITY_TOLERANCE_S = 0.021; // one 20 ms frame, plus the ms rounding of `Word`
const RAW_BIAS_TOLERANCE_MS = 5;
/** E2's raw start bias against the Kokoro reference, by dtype. */
const RAW_BIAS_MS: Record<Wav2vec2Dtype, number> = { q8: 56.3, fp32: 56.1 };
const THREADS = 8;
const RAW = { startOffsetS: 0 };

const WordsSchema = z.array(z.object({ word: z.string(), start: z.number(), end: z.number() }));
const ManifestSchema = z.array(z.object({ id: z.string(), wav: z.string(), text: z.string() }));
const IdsSchema = z.array(z.string());
const RefSchema = z.array(z.object({ id: z.string(), words: WordsSchema }));
const RawRunSchema = z.object({ records: z.array(z.object({ id: z.string(), rich: z.object({ words: WordsSchema }) })) });
const QwenSchema = z.object({ records: z.array(z.object({ id: z.string(), words: WordsSchema })) });

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** PCM16 or float32 WAV to mono samples; enough for the chunk files, not a general reader. */
function readWav(path: string): Audio {
  const buf = readFileSync(path);
  let fmt = { tag: 0, channels: 1, rate: 0, bits: 0 };
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = {
        tag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      const bytesPer = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytesPer * fmt.channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const o = body + i * bytesPer * fmt.channels;
        samples[i] = fmt.tag === 3 ? buf.readFloatLE(o) : buf.readInt16LE(o) / 32768;
      }
      return { samples, sampleRate: fmt.rate };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

/** E2's `scriptWords` split: whitespace words with edge punctuation trimmed. */
function scriptWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length > 0);
}

const matchKey = (word: string): string => [...word.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");

/** Signed start errors in ms over the words an in-order match by spelling pairs up, and the reference word count. */
function startErrorsMs(ref: z.infer<typeof WordsSchema>, hyp: readonly Word[]): { errors: number[]; refWords: number } {
  const want = ref.filter((w) => matchKey(w.word));
  const got = hyp.filter((w) => matchKey(w.text));
  const lcs = Array.from({ length: want.length + 1 }, () => new Array<number>(got.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        matchKey(want[i]!.word) === matchKey(got[j]!.text)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const errors: number[] = [];
  for (let i = 0, j = 0; i < want.length && j < got.length; ) {
    if (matchKey(want[i]!.word) === matchKey(got[j]!.text)) errors.push(1000 * (got[j++]!.start - want[i++]!.start));
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return { errors, refWords: want.length };
}

/** Nearest-rank percentile as the E2 scorer computes it. */
function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1)))]!;
}

const median = (values: readonly number[]): number => percentile(values, 50);
const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const abs = (values: readonly number[]): number[] => values.map(Math.abs);

interface Aligned {
  id: string;
  raw: Word[];
  calibrated: Word[];
}

interface Run {
  aligned: Aligned[];
  loadS: number;
  procS: number;
  audioS: number;
}

/** Aligns only the script words with at least one alignable phone, the set E2 aligned. */
async function alignItems(items: z.infer<typeof ManifestSchema>, voice: "kokoro" | "xtts"): Promise<Run> {
  const g2p = espeakCliG2p();
  const recognizer = wav2vec2Recognizer({ dtype, cacheDir, threads: THREADS });
  const aligned: Aligned[] = [];
  let loadS = 0;
  let procS = 0;
  let audioS = 0;
  try {
    for (const [index, item] of items.entries()) {
      const audio = readWav(item.wav);
      const started = performance.now();
      const words = scriptWords(item.text)
        .map((word) => ({ word, ipa: g2p(word, DEFAULT_PHONE_VOICE) }))
        .filter(({ ipa }) => tokenizeIpa(ipa, recognizer.vocab).length > 0);
      const { logits } = await recognizer.recognizeWithLogits(resample(audio, 16000));
      const text = words.map((w) => w.word);
      const phones = words.map((w) => w.ipa);
      aligned.push({
        id: item.id,
        raw: alignWords(text, phones, logits, { vocab: recognizer.vocab, voice: RAW }),
        calibrated: alignWords(text, phones, logits, { vocab: recognizer.vocab, voice }),
      });
      const seconds = (performance.now() - started) / 1000;
      // The first item pays the lazy model load, so it is reported as load time and left out of the real-time factor.
      if (index === 0) loadS = seconds;
      else {
        procS += seconds;
        audioS += audio.samples.length / audio.sampleRate;
      }
    }
  } finally {
    await recognizer.dispose();
  }
  return { aligned, loadS, procS, audioS };
}

function errorsFor(run: Run, refs: Map<string, z.infer<typeof WordsSchema>>, pick: "raw" | "calibrated") {
  const errors: number[] = [];
  let refWords = 0;
  for (const a of run.aligned) {
    const ref = refs.get(a.id);
    if (!ref) throw new Error(`no reference for item ${a.id}`);
    const got = startErrorsMs(ref, a[pick]);
    errors.push(...got.errors);
    refWords += got.refWords;
  }
  return { errors, refWords };
}

function parityShare(run: Run, harness: Map<string, z.infer<typeof WordsSchema>>): { share: number; compared: number; skipped: number } {
  let within = 0;
  let compared = 0;
  let skipped = 0;
  for (const a of run.aligned) {
    const theirs = harness.get(a.id);
    if (!theirs || theirs.length !== a.raw.length) {
      skipped++;
      continue;
    }
    a.raw.forEach((w, k) => {
      compared++;
      if (Math.abs(w.start - theirs[k]!.start) <= PARITY_TOLERANCE_S) within++;
    });
  }
  return { share: compared === 0 ? 0 : within / compared, compared, skipped };
}

const f1 = (n: number): string => n.toFixed(1);

function report(label: string, run: Run, refs: Map<string, z.infer<typeof WordsSchema>>): void {
  const raw = errorsFor(run, refs, "raw");
  const cal = errorsFor(run, refs, "calibrated");
  console.log(
    `align ${label} ${dtype}: items ${run.aligned.length}, matched ${cal.errors.length}/${cal.refWords} words, ` +
      `raw bias ${f1(mean(raw.errors))} ms, raw start median/p95 ${f1(median(abs(raw.errors)))}/${f1(percentile(abs(raw.errors), 95))} ms, ` +
      `calibrated start median/p95 ${f1(median(abs(cal.errors)))}/${f1(percentile(abs(cal.errors), 95))} ms`,
  );
  console.log(
    `align ${label} ${dtype}: load ${f1(run.loadS)} s, RTF ${(run.procS / run.audioS).toFixed(3)}, ` +
      `maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB, espeak ${espeakVersion() ?? "missing"}`,
  );
}

const ready = Boolean(cacheDir && e2Dir);
const results = (name: string): string => join(e2Dir, name);
const itemsById = (ids: readonly string[]) => {
  const manifest = ManifestSchema.parse(readJson(results("manifest.json")));
  const byId = new Map(manifest.map((m) => [m.id, m]));
  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`manifest has no item ${id}`);
    return item;
  });
};
const wordsById = (rows: readonly { id: string; words: z.infer<typeof WordsSchema> }[]) =>
  new Map(rows.map((r) => [r.id, r.words]));

describe.skipIf(!ready)("alignWords on the E2 beats (wav2vec2, espeak targets)", () => {
  it("reproduces the E2 aligner and meets the Kokoro start bar", async () => {
    const ids = IdsSchema.parse(readJson(results("ids_rf72.json")));
    const run = await alignItems(itemsById(ids), "kokoro");
    const ref = wordsById(RefSchema.parse(readJson(results("kokoro_ref.json"))));
    const harnessRun = RawRunSchema.parse(readJson(join(e2Dir, "raw", `ctc-w2v2-${dtype}.json`)));
    const harness = wordsById(harnessRun.records.map((r) => ({ id: r.id, words: r.rich.words })));

    const parity = parityShare(run, harness);
    const raw = errorsFor(run, ref, "raw");
    const cal = errorsFor(run, ref, "calibrated");
    report("kokoro rf72", run, ref);
    console.log(
      `align kokoro rf72 ${dtype}: parity ${f1(100 * parity.share)}% of ${parity.compared} starts within one frame, ` +
        `${parity.skipped} items skipped on a word-count mismatch`,
    );

    expect(parity.share).toBeGreaterThanOrEqual(PARITY_MIN_SHARE);
    expect(Math.abs(mean(raw.errors) - RAW_BIAS_MS[dtype])).toBeLessThanOrEqual(RAW_BIAS_TOLERANCE_MS);
    expect(median(abs(cal.errors))).toBeLessThanOrEqual(START_MEDIAN_BAR_MS);
    expect(percentile(abs(cal.errors), 95)).toBeLessThanOrEqual(START_P95_BAR_MS);
  }, 3_600_000);

  it.skipIf(!withXtts)("reports the XTTS start error on the AB chunks without gating it", async () => {
    const ids = IdsSchema.parse(readJson(results("ids_ab50.json")));
    const run = await alignItems(itemsById(ids), "xtts");
    const qwen = QwenSchema.parse(readJson(join(e2Dir, "raw", "qwen3-fa-ab50.json")));
    report("xtts ab50", run, wordsById(qwen.records));
    expect(run.aligned).toHaveLength(ids.length);
  }, 3_600_000);
});
