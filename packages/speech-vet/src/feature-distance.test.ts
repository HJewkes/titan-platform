import { describe, expect, it } from "vitest";
import { featureDistance, GLIDE_COST, INDEL_COST, phoneSegments, segmentCost } from "./feature-distance.js";

// Every segment `cleanIpa` can leave from espeak en-us or the lv-60 English decodes, the diphthongs included.
const INVENTORY = [
  "p", "b", "t", "d", "k", "g", "f", "v", "θ", "ð", "s", "z", "ʃ", "ʒ", "h", "m", "n", "ŋ", "l", "ɹ", "w", "j",
  "tʃ", "dʒ", "i", "ɪ", "e", "ɛ", "æ", "a", "ə", "ɚ", "ɜ", "ʌ", "ɑ", "ɒ", "ɔ", "o", "ʊ", "u", "ᵻ",
  "eɪ", "aɪ", "oʊ", "aʊ", "ɔɪ",
];
// Constructed readings of invented names, with stress and length marks the cleaner must drop.
const WORDS = ["vˈeɪlən", "mˈaɪɹə", "tʃˈoʊbɪn", "dʒˈaʊzɛl", "kˈɔɪnəθ", "ðˈæmɪs", "ʃˈuːfɚ", "ŋˈɑʒi", "ɹˈʌpɡʊl", "hˈɜbɒt"];
const STRINGS = [...WORDS, "", "n", "eɪ", "aɪ", "k", "neɪ", "naɪ", "dʒeɪmi", "dʒemi", "iɛfɛf"];

/** mulberry32: a seeded generator, so the random strings are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStrings(count: number, seed: number): string[] {
  const next = seeded(seed);
  const pick = () => INVENTORY[Math.floor(next() * INVENTORY.length)]!;
  return Array.from({ length: count }, () => Array.from({ length: Math.floor(next() * 9) }, pick).join(""));
}

describe("phoneSegments", () => {
  it("keeps lv-60's multi-character tokens whole", () => {
    expect(phoneSegments("tʃeɪndʒ")).toEqual(["tʃ", "eɪ", "n", "dʒ"]);
  });

  it("keeps a combining mark on its phone", () => {
    expect(phoneSegments("bã")).toEqual(["b", "ã"]);
  });

  it("segments the cleaned string, so tie bars and stress marks do not split a token", () => {
    expect(phoneSegments("ˈt͡ʃaɪ")).toEqual(["tʃ", "aɪ"]);
  });
});

describe("featureDistance", () => {
  it("is 0 from every inventory segment and constructed word to itself", () => {
    for (const x of [...INVENTORY, ...WORDS]) expect(featureDistance(x, x), x).toBe(0);
  });

  it("is symmetric", () => {
    for (const a of STRINGS) for (const b of STRINGS) expect(featureDistance(a, b), `${a}|${b}`).toBe(featureDistance(b, a));
  });

  it("stays within [0, 1] on seeded random inventory strings", () => {
    const strings = randomStrings(401, 3034);
    for (let i = 0; i < 400; i++) {
      const d = featureDistance(strings[i]!, strings[i + 1]!);
      expect(d, `${strings[i]}|${strings[i + 1]}`).toBeGreaterThanOrEqual(0);
      expect(d, `${strings[i]}|${strings[i + 1]}`).toBeLessThanOrEqual(1);
    }
  });

  it("prices eɪ/aɪ as one segment whose components are summed, closer than eɪ against k", () => {
    const ea = segmentCost("e", "a");

    expect(featureDistance("eɪ", "aɪ")).toBe(ea);
    expect(featureDistance("neɪ", "naɪ")).toBe(ea / 2);
    expect(featureDistance("eɪ", "aɪ")).toBeLessThan(featureDistance("eɪ", "k"));
  });

  it("charges a dropped segment the indel cost", () => {
    expect(featureDistance("ɛf", "ɛ")).toBe(INDEL_COST / 2);
    expect(featureDistance("", "p")).toBe(INDEL_COST);
  });
});

describe("segmentCost", () => {
  it("prices a diphthong against a single phone as its closer component plus the glide cost", () => {
    expect(segmentCost("eɪ", "e")).toBe(GLIDE_COST);
    expect(segmentCost("e", "eɪ")).toBe(GLIDE_COST);
  });

  it("prices a segment panphon has no row for at 1 against anything but itself", () => {
    expect(segmentCost("#", "p")).toBe(1);
    expect(segmentCost("#", "#")).toBe(0);
  });
});

describe("frozen costs", () => {
  it("keeps an indel cheaper than a full substitution and the glide no dearer than an indel", () => {
    expect(INDEL_COST).toBeLessThan(1);
    expect(GLIDE_COST).toBeLessThanOrEqual(INDEL_COST);
  });
});
