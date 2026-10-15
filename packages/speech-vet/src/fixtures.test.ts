import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import espeak from "./fixtures/espeak-ipa.golden.json" with { type: "json" };
import shingles from "./fixtures/ab-chunk-shingles.json" with { type: "json" };
import replay from "./fixtures/phones-replay.golden.json" with { type: "json" };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const AB_SHA = "b13d8acbedfc280b805422dfde84f1e36d0b3bac";
const MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft";
const AB_CASES = 25; // AB's tests that call espeak-ng; the other 12 collected cases are model-free
const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

const wordSchema = z.object({
  word: z.string(),
  expected_phones: z.string(),
  actual_phones: z.string(),
  distance: z.number(),
  source: z.string(),
});
type Word = z.infer<typeof wordSchema>;
const caseSchema = z.object({
  id: z.string(),
  origin: z.string(),
  tags: z.array(z.string()).optional(),
  text: z.string(),
  raw: z.string(),
  targets: z.array(z.string()),
  unusual: z.array(z.string()),
  espeak: z.record(z.string(), z.string()),
  plain: z.array(wordSchema).optional(),
  expected: z.object({ words: z.array(wordSchema), halluc: z.array(z.unknown()), tail: z.unknown() }),
});
const cases = z.array(caseSchema).parse(replay.cases);

function wordShingles(text: string, size: number): string[] {
  const tokens = text.toLowerCase().replaceAll("’", "'").match(TOKEN) ?? [];
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) {
    out.push(createHash("sha256").update(tokens.slice(i, i + size).join(" ")).digest("hex").slice(0, 12));
  }
  return out;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...strings(inner)]);
  }
  return [];
}

describe("fixture headers", () => {
  it("record the AB sha, espeak version, model and voice", () => {
    expect(espeak._source.audiobookSha).toBe(AB_SHA);
    expect(espeak._source.espeakVersion).toBe("1.52.0");
    expect(replay._source).toMatchObject({
      audiobookSha: AB_SHA,
      espeakVersion: "1.52.0",
      model: MODEL,
      voice: "en-us",
    });
  });
});

describe("espeak recordings", () => {
  const table = new Set(espeak.entries.map((entry) => `${entry.voice}\u0000${entry.text}`));

  it("hold an entry for every voice and text AB's cases pass to espeak", () => {
    const names = Object.keys(espeak.cases);
    expect(names).toHaveLength(AB_CASES);
    const missing = Object.entries(espeak.cases).flatMap(([name, keys]) =>
      keys.filter(([voice, text]) => !table.has(`${voice}\u0000${text}`)).map(([voice, text]) => `${name}: ${voice} ${text}`),
    );
    expect(missing).toEqual([]);
  });

  it("cover both accents the career case compares", () => {
    const voices = new Set(espeak.entries.map((entry) => entry.voice));
    expect(voices).toEqual(new Set(["en-us", "en-gb"]));
  });
});

describe("phones replay", () => {
  const sources = cases.flatMap((c) => c.expected.words.map((w) => w.source));

  it("holds 30 real RF beats with a recording for the chunk and each target", () => {
    const beats = cases.filter((c) => c.origin === "rf-beat");
    expect(beats).toHaveLength(30);
    for (const c of cases) {
      expect(Object.keys(c.espeak), c.id).toContain(c.text);
      for (const target of c.targets) expect(Object.keys(c.espeak), `${c.id}:${target}`).toContain(target);
    }
  });

  it("covers every verdict branch with real and perturbed cases", () => {
    const tags = new Set(cases.flatMap((c) => c.tags ?? []));
    expect(new Set(sources)).toEqual(new Set(["whisper", "xtts", "inconclusive"]));
    expect(cases.some((c) => c.expected.halluc.length > 0)).toBe(true);
    expect(cases.some((c) => c.expected.tail !== null)).toBe(true);
    for (const tag of ["hallucination", "tail", "xtts", "inconclusive", "weakForm", "unusualOverride"]) {
      expect(tags, tag).toContain(tag);
    }
  });

  it("shows the unusual threshold rescuing a word that is a fault without it", () => {
    const c = cases.find((x) => x.tags?.includes("unusualOverride"));
    const plain: Word[] = c?.plain ?? [];
    expect(c?.unusual.length).toBeGreaterThan(0);
    expect(plain[0]?.source).toBe("xtts");
    expect(c?.expected.words[0]?.source).toBe("whisper");
    expect(c?.expected.words[0]?.distance).toBeGreaterThanOrEqual(0.45);
    expect(c?.expected.words[0]?.distance).toBeLessThan(0.7);
  });

  it("holds a weak form that beats the citation at distance 0", () => {
    const c = cases.find((x) => x.tags?.includes("weakForm"));
    expect(c?.expected.words.some((w) => w.distance === 0 && w.source === "whisper")).toBe(true);
  });
});

describe("fixture budget and data rule", () => {
  const files = readdirSync(FIXTURES).map((name) => join(FIXTURES, name));

  it("keeps the fixtures under 2 MB", () => {
    const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it("holds no 6-word run from the third-party AB chunks", () => {
    const deny = new Set<string>(shingles.hashes);
    expect(deny.size).toBeGreaterThan(500);
    const leaks: string[] = [];
    for (const file of files.filter((f) => f.endsWith(".json") && !f.endsWith("ab-chunk-shingles.json"))) {
      for (const text of strings(JSON.parse(readFileSync(file, "utf8")))) {
        if (wordShingles(text, shingles.shingle).some((hash) => deny.has(hash))) leaks.push(`${file}: ${text.slice(0, 30)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("holds no AB chunk or book ids", () => {
    const all = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(all).not.toMatch(/\bb[67]c\d+-\d{3}\b|124774/);
  });

  it("hashes shingles exactly as the Python generator does", () => {
    const text = "Don\u2019t stop: we kept our heads, and we stayed calm_ok.";
    expect(wordShingles(text, 6)).toEqual([
      "037ff918fbca",
      "98b7fe17cb1f",
      "372322346d84",
      "121e2dbecdf8",
      "98fc097a53db",
      "f529b58f2ef2",
    ]);
  });
});
