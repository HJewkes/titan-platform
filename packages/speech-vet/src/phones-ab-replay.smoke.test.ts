import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resample, wav2vec2Recognizer, type Audio } from "@titan-design/speech-stt";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chunkWordVerdicts, detectHallucinations, detectTailArtifact, type WordVerdict } from "./phone-verdicts.js";
import type { PhoneG2p } from "./phones.js";

// Opt-in parity evidence against the AB replay bundle, which holds third-party text and so lives outside the repo.
// Nothing here is read at import time unless SPEECH_PHONES_AB_REPLAY is set, and no case text appears in this file.
//
//   SPEECH_PHONES_AB_REPLAY  the bundle dir holding cases.json                           (part a)
//   SPEECH_PHONES_SMOKE_CACHE  a cacheDir already holding the pinned fp32 weights        (parts b, c)
//   SPEECH_PHONES_AB_INPUTS  a dir of <id>.f32, E6's 16 kHz inputs                        (part b)
//   SPEECH_PHONES_AB_PT      E6's pt.jsonl, the PyTorch frame ids                         (part b)
//   SPEECH_PHONES_AB_MANIFEST  E6's manifest.json, with each chunk's 24 kHz wav path     (part c)
//
// Vitest forces TITAN_SPEECH_OFFLINE, so the weights must be cached first: run `wav2vec2Recognizer({ cacheDir })`
// once from a plain node script with the variable unset.
const bundleDir = process.env.SPEECH_PHONES_AB_REPLAY ?? "";
const cacheDir = process.env.SPEECH_PHONES_SMOKE_CACHE ?? "";
const inputsDir = process.env.SPEECH_PHONES_AB_INPUTS ?? "";
const ptPath = process.env.SPEECH_PHONES_AB_PT ?? "";
const manifestPath = process.env.SPEECH_PHONES_AB_MANIFEST ?? "";

const WordSourceSchema = z.object({ source: z.string() });
const VerdictSchema = z.object({
  words: z.array(z.unknown()),
  halluc: z.array(z.unknown()),
  tail: z.unknown().nullable(),
});
const CaseSchema = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  raw: z.string(),
  targets: z.array(z.string()),
  unusual: z.array(z.string()),
  espeak: z.record(z.string(), z.string()),
  expected: VerdictSchema,
});
const BundleSchema = z.object({ voice: z.string(), cases: z.array(CaseSchema) });
type Case = z.infer<typeof CaseSchema>;

const REGRESSION_KIND = "ab-test-regression";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

// The bundle holds AB's own output, so its keys are Python's.
const asRecorded = ({ word, expectedPhones, actualPhones, distance, source }: WordVerdict) => ({
  word,
  expected_phones: expectedPhones,
  actual_phones: actualPhones,
  distance,
  source,
});

function recordedG2p(c: Case): PhoneG2p {
  return (text) => {
    const ipa = c.espeak[text];
    if (ipa === undefined) throw new Error(`case ${c.id}: no espeak recording for a ${text.length}-char input`);
    return ipa;
  };
}

function verdictsFor(c: Case, voice: string, raw: string) {
  const g2p = recordedG2p(c);
  return {
    words: chunkWordVerdicts(c.text, raw, { g2p, voice, targets: c.targets, unusual: c.unusual }).map(asRecorded),
    halluc: detectHallucinations(c.text, raw, { g2p, voice }),
    tail: detectTailArtifact(c.text, raw, { g2p, voice }),
  };
}

/** The fields of the verdicts that decide a chunk; the golden comparison is on the whole object. */
function decisions(v: z.infer<typeof VerdictSchema>) {
  return {
    sources: v.words.map((w) => WordSourceSchema.parse(w).source),
    halluc: v.halluc.length,
    tail: v.tail === null ? "none" : "tail",
  };
}

function readF32(path: string): Float32Array {
  const bytes = readFileSync(path);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

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

const bundle = bundleDir ? BundleSchema.parse(readJson(join(bundleDir, "cases.json"))) : undefined;
const chunks = bundle?.cases.filter((c) => c.kind !== REGRESSION_KIND) ?? [];
const regression = bundle?.cases.filter((c) => c.kind === REGRESSION_KIND) ?? [];

describe.skipIf(!bundle)("AB replay bundle: recorded raw output through the TS verdicts", () => {
  it("gives AB's verdicts on every chunk", () => {
    const voice = bundle?.voice ?? "";
    const equal = chunks.filter((c) => {
      try {
        expect(verdictsFor(c, voice, c.raw)).toEqual(c.expected);
        return true;
      } catch {
        return false;
      }
    });
    console.log(`AB replay (a): ${equal.length}/${chunks.length} verdicts equal`);
    expect(chunks).toHaveLength(30);
    expect(equal).toHaveLength(chunks.length);
  });

  it("keeps the duplicate-prefix regression case inconclusive, not xtts", () => {
    const voice = bundle?.voice ?? "";
    expect(regression).toHaveLength(1);
    for (const c of regression) {
      const v = verdictsFor(c, voice, c.raw);
      expect(v).toEqual(c.expected);
      const sources = v.words.map((w) => (w as { source: string }).source);
      console.log(`AB replay (a): regression case sources ${[...new Set(sources)].join(",")}`);
      expect(sources).toContain("inconclusive");
      expect(sources).not.toContain("xtts");
    }
  });
});

const e2eReady = Boolean(bundle && cacheDir && inputsDir && ptPath);

describe.skipIf(!e2eReady)("AB replay bundle: fp32 recognizer end to end", () => {
  it("gives PyTorch's frame ids and AB's verdicts from E6's 16 kHz inputs", async () => {
    const pt = new Map(
      readFileSync(ptPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const row = z.object({ id: z.string(), ids: z.array(z.number()) }).parse(JSON.parse(line));
          return [row.id, row.ids] as const;
        }),
    );
    const recognizer = wav2vec2Recognizer({ cacheDir, device: "cpu" });
    const voice = bundle?.voice ?? "";
    let idsEqual = 0;
    let verdictsEqual = 0;
    let flippedFrames = 0;
    let totalFrames = 0;
    try {
      for (const c of chunks) {
        const want = pt.get(c.id);
        if (!want) throw new Error(`pt.jsonl has no row for case ${c.id}`);
        const { ids, phones } = await recognizer.recognizeWithLogits({
          samples: readF32(join(inputsDir, `${c.id}.f32`)),
          sampleRate: 16000,
        });
        const flipped = ids.length === want.length ? ids.filter((id, i) => id !== want[i]).length : want.length;
        flippedFrames += flipped;
        totalFrames += want.length;
        if (flipped === 0) idsEqual++;
        if (JSON.stringify(verdictsFor(c, voice, phones)) === JSON.stringify(c.expected)) verdictsEqual++;
      }
    } finally {
      await recognizer.dispose();
    }
    console.log(
      `AB replay (b): ${idsEqual}/${chunks.length} frame ids equal (${flippedFrames}/${totalFrames} frames differ), ` +
        `${verdictsEqual}/${chunks.length} verdicts equal, maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`,
    );
    expect(idsEqual).toBe(chunks.length);
    expect(verdictsEqual).toBe(chunks.length);
  }, 1_800_000);
});

describe.skipIf(!(e2eReady && manifestPath))("AB replay bundle: 24 kHz wavs through the TS resampler", () => {
  it("reports decision drift without failing on it", async () => {
    const manifest = z
      .array(z.object({ id: z.string(), wav: z.string() }))
      .parse(readJson(manifestPath));
    const wavById = new Map(manifest.map((m) => [m.id, m.wav]));
    const recognizer = wav2vec2Recognizer({ cacheDir, device: "cpu" });
    const voice = bundle?.voice ?? "";
    let rawEqual = 0;
    let decisionsEqual = 0;
    let verdictsEqual = 0;
    try {
      for (const c of chunks) {
        const wav = wavById.get(c.id);
        if (!wav) throw new Error(`manifest has no row for case ${c.id}`);
        const phones = await recognizer.recognize(resample(readWav(wav), 16000));
        const got = verdictsFor(c, voice, phones);
        if (phones === c.raw) rawEqual++;
        if (JSON.stringify(decisions(got)) === JSON.stringify(decisions(c.expected))) {
          decisionsEqual++;
        }
        if (JSON.stringify(got) === JSON.stringify(c.expected)) verdictsEqual++;
      }
    } finally {
      await recognizer.dispose();
    }
    console.log(
      `AB replay (c): ${rawEqual}/${chunks.length} raw decodes equal, ` +
        `${decisionsEqual}/${chunks.length} decisions equal, ${verdictsEqual}/${chunks.length} verdicts equal`,
    );
    expect(chunks.length).toBeGreaterThan(0);
  }, 1_800_000);
});
