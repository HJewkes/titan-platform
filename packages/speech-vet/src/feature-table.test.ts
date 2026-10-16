import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FEATURE_COUNT, FEATURE_NAMES, featureVector, parseFeatureCsv } from "./feature-table.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const CSV_URL = new URL("../data/panphon/ipa_all.csv", import.meta.url);
const README = fs.readFileSync(new URL("../data/README.md", import.meta.url), "utf8");

// Every segment `cleanIpa` can leave from espeak en-us or the lv-60 English decodes.
const CONSONANTS = ["p", "b", "t", "d", "k", "g", "f", "v", "θ", "ð", "s", "z", "ʃ", "ʒ", "h", "m", "n", "ŋ", "l", "ɹ", "w", "j", "tʃ", "dʒ"];
const VOWELS = ["i", "ɪ", "e", "ɛ", "æ", "a", "ə", "ɚ", "ɜ", "ʌ", "ɑ", "ɒ", "ɔ", "o", "ʊ", "u", "ᵻ"];

function recorded(label: string): string {
  const match = new RegExp(`^- ${label}: \`([^\`]+)\``, "m").exec(README);
  if (!match?.[1]) throw new Error(`data/README.md has no "${label}" line`);
  return match[1];
}

describe("vendored panphon table", () => {
  it("matches the bytes and sha256 recorded in data/README.md", () => {
    const bytes = fs.readFileSync(CSV_URL);

    expect(bytes.length).toBe(Number(recorded("Bytes")));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(recorded("sha256"));
  });

  it("has exactly the recorded non-tone feature columns", () => {
    const header = fs.readFileSync(CSV_URL, "utf8").split("\r\n")[0] ?? "";
    const nonTone = header.split(",").slice(1).filter((name) => name !== "hitone" && name !== "hireg");

    expect(nonTone.join(" ")).toBe(recorded("Non-tone features"));
    expect(nonTone).toEqual([...FEATURE_NAMES]);
    expect(FEATURE_COUNT).toBe(Number(recorded("FEATURE_COUNT")));
    expect(FEATURE_COUNT).toBe(nonTone.length);
  });

  it("rejects a header whose features differ from the recorded list", () => {
    expect(() => parseFeatureCsv("ipa,syl,son\np,-,-\n")).toThrow(/differ/);
  });
});

describe("featureVector", () => {
  it("resolves every English inventory segment, through aliases where needed", () => {
    const missing = [...CONSONANTS, ...VOWELS].filter((s) => featureVector(s) === undefined);

    expect(missing).toEqual([]);
  });

  it("returns FEATURE_COUNT values for each segment", () => {
    expect(featureVector("p")).toHaveLength(FEATURE_COUNT);
  });

  it("resolves each recorded alias to the vector of its panphon row", () => {
    const pairs = recorded("Alias map").split(" ").map((pair) => pair.split("="));

    expect(pairs.length).toBeGreaterThan(0);
    for (const [from = "", to = ""] of pairs) {
      expect(featureVector(from), from).toBeDefined();
      expect(featureVector(from), from).toEqual(featureVector(to));
    }
  });

  it("gives vowels and consonants opposite syl signs", () => {
    for (const vowel of VOWELS) expect(featureVector(vowel)?.[0], vowel).toBe(1);
    for (const consonant of CONSONANTS) expect(featureVector(consonant)?.[0], consonant).toBe(-1);
  });

  it("reports an unknown symbol as undefined without throwing", () => {
    expect(featureVector("\u{1F600}")).toBeUndefined();
    expect(featureVector("eɪ")).toBeUndefined();
  });

  it("reads the CSV once across calls", async () => {
    vi.resetModules();
    const { readFileSync } = await import("node:fs");
    const reads = vi.mocked(readFileSync);
    reads.mockClear();
    const fresh = await import("./feature-table.js");

    fresh.featureVector("p");
    fresh.featureVector("b");
    fresh.featureVector("ʘ");

    expect(reads).toHaveBeenCalledTimes(1);
  });
});
