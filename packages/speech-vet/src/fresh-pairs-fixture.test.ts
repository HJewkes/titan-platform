import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { misakiToIpa } from "@titan-design/speech-g2p";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import shingles from "./fixtures/ab-chunk-shingles.json" with { type: "json" };
import { phoneSegments } from "./feature-distance.js";
import fresh from "./fixtures/fresh-pairs.json" with { type: "json" };
import { cleanIpa } from "./phones.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fresh-pairs.json");
const BUDGET_BYTES = 40 * 1024;
const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const QUOTAS: Readonly<Record<string, number>> = {
  "eɪ/aɪ": 10,
  "oʊ/aʊ": 6,
  "ɔɪ/aɪ": 4,
  affricate: 4,
  "diphthong/monophthong": 4,
  vowel: 8,
  consonant: 8,
  indel: 4,
};
const CLASS_CONTRASTS: Readonly<Record<string, readonly string[]>> = {
  "eɪ/aɪ": ["eɪ/aɪ"],
  "oʊ/aʊ": ["oʊ/aʊ"],
  "ɔɪ/aɪ": ["ɔɪ/aɪ"],
  affricate: ["dʒ/j", "tʃ/ʃ", "tʃ/t", "dʒ/d"],
  "diphthong/monophthong": ["eɪ/ɛ", "aɪ/ɪ", "oʊ/ɔ", "ɔɪ/ɔ"],
  vowel: ["ɛ/æ", "ɪ/i", "ʊ/u", "ʌ/ɑ", "ɛ/ɪ"],
  consonant: ["θ/t", "ð/d", "s/z", "v/b", "n/ŋ", "l/ɹ", "p/b", "k/ɡ"],
};
const CONDITIONS = ["af_heart|isolated", "af_heart|carrier", "am_michael|isolated", "am_michael|carrier"];
const MIN_REPEAT_GAP = 20;
const MAX_CONDITION_RUN = 3;

const readingSchema = z.object({ misaki: z.string(), ipa: z.string(), respell: z.string() });
const pairSchema = z.object({
  id: z.string(),
  class: z.string(),
  word: z.string(),
  contrast: z.tuple([z.string(), z.string()]),
  A: readingSchema,
  B: readingSchema,
});
type Pair = z.infer<typeof pairSchema>;
const itemSchema = z.tuple([
  z.string(),
  z.enum(["A", "B"]),
  z.enum(["af_heart", "am_michael"]),
  z.enum(["isolated", "carrier"]),
  z.enum(["A", "B"]),
  z.enum(["first", "repeat", "practice"]),
]);
type Item = z.infer<typeof itemSchema>;
const pairs = z.array(pairSchema).parse(fresh.pairs);
const practice = z.array(pairSchema).parse(fresh.practice);
const sessions = z.array(z.object({ session: z.string(), items: z.array(itemSchema) })).parse(fresh.owner.sessions);
const practiceItems = z.array(itemSchema).parse(fresh.owner.practice);
const allPairs = [...pairs, ...practice];
const readings = allPairs.flatMap((p) => [p.A, p.B]);

/** The one substitution or indel that turns `a` into `b`, as [a side, b side] with "" for absence. */
function contrastOf(a: string[], b: string[]): [string, string] | undefined {
  if (a.length === b.length) {
    const diffs = a.flatMap((x, i): [string, string][] => (x === b[i] ? [] : [[x, b[i]!]]));
    return diffs.length === 1 ? diffs[0] : undefined;
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  if (long.length !== short.length + 1) return undefined;
  const i = long.findIndex((_, k) => [...long.slice(0, k), ...long.slice(k + 1)].join(" ") === short.join(" "));
  if (i < 0) return undefined;
  return a.length > b.length ? [long[i]!, ""] : ["", long[i]!];
}

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

const fill = (template: string, word: string, misaki: string) => template.replace("{word}", word).replace("{misaki}", misaki);
const condition = (item: Item) => `${item[2]}|${item[3]}`;
const clipKey = (item: Item) => `${item[0]}|${item[1]}`;
const pairCondition = (sessionItems: Item[], id: string) => sessionItems.find((x) => x[0] === id && x[5] === "first")!;

describe("fresh pair quotas", () => {
  it("holds 48 pairs to the class quotas, plus 3 practice pairs", () => {
    const counts: Record<string, number> = {};
    for (const p of pairs) counts[p.class] = (counts[p.class] ?? 0) + 1;
    expect(counts).toEqual(QUOTAS);
    expect(pairs).toHaveLength(48);
    expect(practice).toHaveLength(3);
  });

  it("uses unique ids and words", () => {
    expect(new Set(allPairs.map((p) => p.id)).size).toBe(allPairs.length);
    expect(new Set(allPairs.map((p) => p.word.toLowerCase())).size).toBe(allPairs.length);
  });

  it("covers every contrast each class names", () => {
    for (const [cls, contrasts] of Object.entries(CLASS_CONTRASTS)) {
      const used = pairs.filter((p) => p.class === cls).map((p) => p.contrast.join("/"));
      expect(new Set(used), cls).toEqual(new Set(contrasts));
    }
    for (const p of pairs.filter((q) => q.class === "indel")) expect(p.contrast[1], p.id).toBe("");
  });
});

describe("fresh pair readings", () => {
  it("differ by exactly the stated contrast: one segment substitution, or one indel", () => {
    const wrong = allPairs.filter((p) => {
      const found = contrastOf(phoneSegments(p.A.ipa), phoneSegments(p.B.ipa));
      return found?.join("/") !== p.contrast.join("/");
    });
    expect(wrong.map((p) => p.id)).toEqual([]);
  });

  it("store IPA equal to misakiToIpa of the misaki override", () => {
    for (const r of readings) expect(r.ipa, r.misaki).toBe(misakiToIpa(r.misaki));
  });

  it("fill the carrier so its IPA equals misakiToIpa of its misaki", () => {
    const { carrier } = fresh.contexts;
    for (const r of readings) {
      expect(misakiToIpa(carrier.misaki.replace("{misaki}", r.misaki))).toBe(carrier.ipa.replace("{ipa}", r.ipa));
    }
  });

  it("avoid the symbols E5's scorer and misakiToIpa fold differently (əɹ, ɚ, ɜ, T, ᵻ, Q)", () => {
    expect(readings.filter((r) => /əɹ|[ɚɜTᵻQ]/u.test(r.misaki)).map((r) => r.misaki)).toEqual([]);
  });
});

describe("E5 disjointness", () => {
  const hashOf = (p: Pair) =>
    createHash("sha256")
      .update([cleanIpa(p.A.ipa), cleanIpa(p.B.ipa)].sort().join("|"))
      .digest("hex")
      .slice(0, 12);

  it("holds E5's 40 words and 40 reading-pair hashes", () => {
    expect(fresh.e5Deny.words).toHaveLength(40);
    expect(new Set(fresh.e5Deny.readingPairHashes).size).toBe(40);
  });

  it("uses no E5 word", () => {
    const deny = new Set(fresh.e5Deny.words.map((w) => w.toLowerCase()));
    expect(allPairs.filter((p) => deny.has(p.word.toLowerCase())).map((p) => p.word)).toEqual([]);
  });

  it("repeats no E5 reading pair in either order", () => {
    const deny = new Set(fresh.e5Deny.readingPairHashes);
    expect(allPairs.filter((p) => deny.has(hashOf(p))).map((p) => p.id)).toEqual([]);
  });
});

describe("pre-registered analysis", () => {
  it("carries the seed and every rule of the bar, the thresholds, the A/B extension, the guard and the freeze", () => {
    expect(fresh.owner).toMatchObject({ seed: 3034, rng: "mulberry32", conditions: CONDITIONS });
    const text = expect.any(String);
    expect(fresh.analysis).toMatchObject({
      preRegistration: text,
      conditions: { voices: ["af_heart", "am_michael"], contexts: ["isolated", "carrier"], speed: 1 },
      bar: { mine: text, theirs: text, heard: text, trial: text, pairCondition: text, pass: text, secondary: text },
      thresholds: { points: text, label: text, dropped: text, T: text, T_short: text, T_unusual: text },
      owner: { rule: text, firstCondition: text, order: text, left: text, draws: text, keys: text, blind: text },
      extension: { decision: text, prefix: text, aOnly: text, join: text },
      guard: { decision: text, ifAdopted: text, ifDeclined: text, timing: text },
      freeze: text,
    });
  });
});

describe("owner playlist", () => {
  it("opens with the 6 practice items, one per practice reading", () => {
    expect(practiceItems.map(clipKey).sort()).toEqual(practice.flatMap((p) => [`${p.id}|A`, `${p.id}|B`]).sort());
    expect(practiceItems.every((x) => x[5] === "practice")).toBe(true);
  });

  it("orders session A before session B, each with 96 first hearings and 10 repeats", () => {
    expect(sessions.map((s) => s.session)).toEqual(["A", "B"]);
    const every = pairs.flatMap((p) => [`${p.id}|A`, `${p.id}|B`]).sort();
    for (const { session, items } of sessions) {
      const firsts = items.filter((x) => x[5] === "first");
      expect(firsts.map(clipKey).sort(), session).toEqual(every);
      expect(items.filter((x) => x[5] === "repeat"), session).toHaveLength(10);
      expect(items, session).toHaveLength(106);
    }
  });

  it("plays both readings of a pair in one condition per session, 24 first hearings per condition", () => {
    for (const { items } of sessions) {
      const firsts = items.filter((x) => x[5] === "first");
      for (const p of pairs) expect(new Set(firsts.filter((x) => x[0] === p.id).map(condition)).size, p.id).toBe(1);
      for (const c of CONDITIONS) expect(firsts.filter((x) => condition(x) === c), c).toHaveLength(24);
    }
  });

  it("gives session B the condition that differs from session A's in both voice and context", () => {
    const [a, b] = sessions.map((s) => s.items);
    for (const p of pairs) {
      const [inA, inB] = [pairCondition(a!, p.id), pairCondition(b!, p.id)];
      expect(inB[2], p.id).not.toBe(inA[2]);
      expect(inB[3], p.id).not.toBe(inA[3]);
    }
  });

  it("places each repeat at least 20 items after its first hearing", () => {
    for (const { items } of sessions) {
      items.forEach((x, i) => {
        if (x[5] !== "repeat") return;
        const firstAt = items.findIndex((y) => y[5] === "first" && clipKey(y) === clipKey(x));
        expect(i - firstAt, clipKey(x)).toBeGreaterThanOrEqual(MIN_REPEAT_GAP);
      });
    }
  });

  it("never plays a pair twice in a row or a condition more than 3 times in a row", () => {
    for (const { items } of sessions) {
      let run = 1;
      for (let i = 1; i < items.length; i++) {
        expect(items[i]![0], `item ${i}`).not.toBe(items[i - 1]![0]);
        run = condition(items[i]!) === condition(items[i - 1]!) ? run + 1 : 1;
        expect(run, `item ${i}`).toBeLessThanOrEqual(MAX_CONDITION_RUN);
      }
    }
  });
});

describe("synthetic-only data rule", () => {
  it("holds no 6-word run from the third-party AB chunks, carrier sentences included", () => {
    const deny = new Set<string>(shingles.hashes);
    const carriers = allPairs.flatMap((p) => [p.A, p.B].map((r) => fill(fresh.contexts.carrier.text, p.word, r.misaki)));
    const leaks = [...strings(fresh), ...carriers].filter((text) =>
      wordShingles(text, shingles.shingle).some((hash) => deny.has(hash)),
    );
    expect(leaks.map((text) => text.slice(0, 30))).toEqual([]);
  });

  it("stays under 40 KB", () => {
    expect(statSync(FIXTURE).size).toBeLessThan(BUDGET_BYTES);
  });
});
