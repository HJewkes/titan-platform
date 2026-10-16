import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import shingles from "./fixtures/ab-chunk-shingles.json" with { type: "json" };
import fresh from "./fixtures/fresh-pairs.json" with { type: "json" };
import recognized from "./fixtures/fresh-pairs.recognized.json" with { type: "json" };
import { featureDistance } from "./feature-distance.js";
import { cleanIpa, phonemeDistance } from "./phones.js";

type Distance = (expected: string, actual: string) => number;
type Reading = "A" | "B";

const trialSchema = z.object({
  pair: z.string(),
  reading: z.enum(["A", "B"]),
  voice: z.string(),
  context: z.enum(["isolated", "carrier"]),
  decode: z.string(),
  kokoroPhonemes: z.array(z.string()),
});
type Trial = z.infer<typeof trialSchema>;

const trials = z.array(trialSchema).parse(recognized.trials);
const pairsById = new Map(fresh.pairs.map((p) => [p.id, p]));
const other = (reading: Reading): Reading => (reading === "A" ? "B" : "A");

/** The pre-registered "mine" string: the context's IPA template filled with the reading, punctuation dropped. */
function expectedPhones(context: Trial["context"], ipa: string): string {
  return cleanIpa(fresh.contexts[context].ipa.replace("{ipa}", ipa)).replace(/[.,?!]/gu, "");
}

function separated(trial: Trial, distance: Distance): { win: boolean; tie: boolean } {
  const pair = pairsById.get(trial.pair)!;
  const heard = cleanIpa(trial.decode);
  const mine = distance(expectedPhones(trial.context, pair[trial.reading].ipa), heard);
  const theirs = distance(expectedPhones(trial.context, pair[other(trial.reading)].ipa), heard);
  return { win: mine < theirs, tie: mine === theirs };
}

interface Cell {
  pair: string;
  voice: string;
  context: Trial["context"];
  passed: boolean;
  trialWins: number;
  ties: number;
}

function cells(distance: Distance): Cell[] {
  const byCell = new Map<string, Trial[]>();
  for (const trial of trials) {
    const key = [trial.pair, trial.voice, trial.context].join("|");
    byCell.set(key, [...(byCell.get(key) ?? []), trial]);
  }
  return [...byCell.values()].map((group) => {
    const results = group.map((t) => separated(t, distance));
    const [first] = group;
    return {
      pair: first!.pair,
      voice: first!.voice,
      context: first!.context,
      passed: group.length === 2 && results.every((r) => r.win),
      trialWins: results.filter((r) => r.win).length,
      ties: results.filter((r) => r.tie).length,
    };
  });
}

function count<K extends string>(all: Cell[], key: (cell: Cell) => K): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cell of all) if (cell.passed) out[key(cell)] = (out[key(cell)] ?? 0) + 1;
  return out;
}

const classOf = (cell: Cell): string => pairsById.get(cell.pair)!.class;
const conditionOf = (cell: Cell): string => `${cell.voice}|${cell.context}`;
const sorted = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));

const featureCells = cells(featureDistance);
const sequenceCells = cells(phonemeDistance);
const pooled = (all: Cell[]): number => all.filter((c) => c.passed).length;

const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

function wordShingles(text: string, size: number): string[] {
  const tokens = text.toLowerCase().replaceAll("’", "'").match(TOKEN) ?? [];
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) {
    out.push(createHash("sha256").update(tokens.slice(i, i + size).join(" ")).digest("hex").slice(0, 12));
  }
  return out;
}

function vocab(): Set<string> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "speech-stt", "data", "wav2vec2-lv60-espeak-vocab.json");
  return new Set(Object.keys(z.record(z.string(), z.number()).parse(JSON.parse(readFileSync(file, "utf8")))));
}

describe("fresh minimal-pair bar (TP-3034 S3)", () => {
  it("holds a decode for every reading of every pair in every condition", () => {
    const expected = fresh.pairs.flatMap((p) =>
      fresh.analysis.conditions.voices.flatMap((voice) =>
        fresh.analysis.conditions.contexts.flatMap((context) =>
          (["A", "B"] as const).map((reading) => [p.id, reading, voice, context].join("|")),
        ),
      ),
    );
    const held = trials.map((t) => [t.pair, t.reading, t.voice, t.context].join("|"));
    expect(trials).toHaveLength(384);
    expect([...held].sort()).toEqual([...expected].sort());
    expect(featureCells).toHaveLength(192);
  });

  it("decodes only vocab tokens", () => {
    const known = vocab();
    const unknown = trials.flatMap((t) => t.decode.split(" ").filter((tok) => !known.has(tok)));
    expect(unknown).toEqual([]);
  });

  it("records the pooled pair-condition separation of both distances", () => {
    expect({ feature: pooled(featureCells), sequence: pooled(sequenceCells) }).toEqual(MEASURED.pooled);
  });

  it("records separation per condition and per class", () => {
    expect({
      featureCondition: sorted(count(featureCells, conditionOf)),
      sequenceCondition: sorted(count(sequenceCells, conditionOf)),
      featureClass: sorted(count(featureCells, classOf)),
      sequenceClass: sorted(count(sequenceCells, classOf)),
    }).toEqual(MEASURED.breakdown);
  });

  it("records trial wins and ties", () => {
    const tally = (all: Cell[]) => ({
      trialWins: all.reduce((n, c) => n + c.trialWins, 0),
      ties: all.reduce((n, c) => n + c.ties, 0),
    });
    expect({ feature: tally(featureCells), sequence: tally(sequenceCells) }).toEqual(MEASURED.trials);
  });

  it("has no fixture string that shares a six-word run with the books", () => {
    const deny = new Set<string>(shingles.hashes);
    const texts = trials.flatMap((t) => [t.decode, ...t.kokoroPhonemes]);
    expect(texts.filter((s) => wordShingles(s, shingles.shingle).some((h) => deny.has(h)))).toEqual([]);
  });

  it("carries no path or file name", () => {
    const home = ["", "Users", ""].join("/");
    const text = JSON.stringify(recognized);
    expect([home, ".wav", ".jsonl", "play/"].filter((needle) => text.includes(needle))).toEqual([]);
  });
});

// The bar FAILED: pre-registered it needed feature >= 183 of 192 and a lead of >= 10 points over sequence
// (>= 19.2 pair-conditions); it measured 162 against 154, so the >= assertions are left out (owner decision D-T8b-3).
const MEASURED = {
  pooled: { feature: 162, sequence: 154 },
  breakdown: {
    featureCondition: {
      "af_heart|carrier": 43,
      "af_heart|isolated": 39,
      "am_michael|carrier": 44,
      "am_michael|isolated": 36,
    },
    sequenceCondition: {
      "af_heart|carrier": 41,
      "af_heart|isolated": 37,
      "am_michael|carrier": 42,
      "am_michael|isolated": 34,
    },
    featureClass: {
      affricate: 16,
      consonant: 30,
      "diphthong/monophthong": 9,
      "eɪ/aɪ": 40,
      indel: 14,
      "oʊ/aʊ": 19,
      vowel: 25,
      "ɔɪ/aɪ": 9,
    },
    sequenceClass: {
      affricate: 16,
      consonant: 29,
      "diphthong/monophthong": 11,
      "eɪ/aɪ": 40,
      indel: 15,
      "oʊ/aʊ": 18,
      vowel: 21,
      "ɔɪ/aɪ": 4,
    },
  },
  trials: {
    feature: { ties: 15, trialWins: 353 },
    sequence: { ties: 27, trialWins: 345 },
  },
};
