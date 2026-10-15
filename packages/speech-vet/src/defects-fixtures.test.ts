import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import shingles from "./fixtures/ab-chunk-shingles.json" with { type: "json" };
import defects from "./fixtures/defects.golden.json" with { type: "json" };
import metaphone from "./fixtures/metaphone.golden.json" with { type: "json" };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const AB_SHA = "b13d8acbedfc280b805422dfde84f1e36d0b3bac";
const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const WORD = /^[a-zſ0-9']+$/u;
const CONSTRUCTED_NAMES = new Set(["Vela", "ASAP"]);
const BUDGET_BYTES = 100 * 1024;

interface Defect {
  kind: string;
  causes: string[];
}
interface DefectCase {
  id: string;
  tags: string[];
  expected: string;
  on: Defect[];
  off: Defect[];
}
const cases = defects.cases as unknown as DefectCase[];
const confirms = defects.confirm as unknown as DefectCase[];

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

/** Capitalised words that do not open a sentence. A lone capital letter is a spelled-out letter, not a name. */
function midSentenceCapitals(text: string): string[] {
  return [...text.matchAll(/\p{Lu}[\p{L}']+/gu)]
    .filter((match) => {
      const before = text.slice(0, match.index).trimEnd();
      return before !== "" && !/[.!?]$/u.test(before);
    })
    .map((match) => match[0]);
}

interface Heard {
  text: string;
  words: { text: string }[];
}

function transcriptTexts(c: DefectCase): string[] {
  const held = c as unknown as { transcript?: Heard; base?: Heard; confirm?: Heard };
  return [held.transcript, held.base, held.confirm].flatMap((t) => (t ? [t.text, ...t.words.map((w) => w.text)] : []));
}

const outputs =[...cases, ...confirms].flatMap((c) => [...c.on, ...c.off]);

describe("fixture headers", () => {
  it("record the AB sha, jellyfish 1.2.1 (rust) and the python version", () => {
    for (const source of [defects._source, metaphone._source]) {
      expect(source.audiobookSha).toBe(AB_SHA);
      expect(source.jellyfish).toBe("1.2.1");
      expect(source.build).toBe("rust");
      expect(source.python).toBe("3.12");
    }
  });
});

describe("defect golden coverage", () => {
  const tags = new Set([...cases, ...confirms].flatMap((c) => c.tags));
  const ids = new Set([...cases, ...confirms].map((c) => c.id));

  it("holds the three-hundred-twelve case the task names", () => {
    expect(ids).toContain("three-hundred-twelve");
  });

  it("has every defect kind and cause in a recorded output", () => {
    expect(new Set(outputs.map((d) => d.kind))).toEqual(new Set(["substitution", "omission", "low_confidence"]));
    const causes = new Set(outputs.flatMap((d) => d.causes));
    for (const cause of ["number", "stylized_elongation", "unusual_word", "chunk_boundary"]) {
      expect(causes, cause).toContain(cause);
    }
    expect(causes).not.toContain("smushed");
  });

  it("has every structural tag and trap", () => {
    const required = [
      "grouped", "one-to-one", "stopword-omission", "multi-content-omission", "logprob", "compression-ratio",
      "segment-covered", "text-only", "digit-as-word", "three-hundred-twelve", "one-thirty-six", "zero-zero",
      "letter-name", "low-prob-homophone", "trap:T1", "trap:T2", "trap:T3", "trap:T4", "trap:T5", "trap:T6", "trap:T7",
    ];
    for (const tag of required) expect(tags, tag).toContain(tag);
  });

  it("ties a stopword-only omission to no defect and a two-word omission to severity 0.7", () => {
    expect(cases.find((c) => c.id === "omit-stopword-only")?.on).toEqual([]);
    const multi = cases.find((c) => c.id === "omit-two-content-words")?.on ?? [];
    expect(multi).toMatchObject([{ kind: "omission", severity: 0.7 }]);
  });

  it("records the off output as the on output without signal A", () => {
    const flagged = cases.filter((c) => c.on.some((d) => d.kind === "low_confidence"));
    expect(flagged.length).toBeGreaterThan(0);
    for (const c of flagged) expect(c.off.every((d) => d.kind !== "low_confidence"), c.id).toBe(true);
  });

  it("records scanNumber rows and a confirm row per outcome", () => {
    expect(defects.scanNumber.find((r) => r.norms.join(" ") === "three hundred twelve")).toMatchObject({ value: "312", end: 3 });
    expect(confirms.length).toBeGreaterThanOrEqual(6);
  });
});

describe("metaphone golden", () => {
  const words = metaphone.cases.map((c) => c.word);

  it("holds 200 distinct words of the allowed alphabet", () => {
    expect(words).toHaveLength(200);
    expect(new Set(words).size).toBe(200);
    expect(words.filter((w) => !WORD.test(w))).toEqual([]);
  });

  it("holds at least 10 words each ending in mb, gn and gh", () => {
    for (const ending of ["mb", "gn", "gh"]) {
      expect(words.filter((w) => w.endsWith(ending)).length, ending).toBeGreaterThanOrEqual(10);
    }
  });

  it("lists no allowed difference yet", () => {
    expect(metaphone.allowedDifferences).toEqual([]);
  });
});

describe("synthetic-only data rule", () => {
  it("holds no 6-word run from the third-party AB chunks", () => {
    const deny = new Set<string>(shingles.hashes);
    const leaks = [defects, metaphone].flatMap((fixture) =>
      strings(fixture).filter((text) => wordShingles(text, shingles.shingle).some((hash) => deny.has(hash))),
    );
    expect(leaks.map((text) => text.slice(0, 30))).toEqual([]);
  });

  it("holds no capitalised word outside the constructed names and sentence starts", () => {
    const stray = [...cases, ...confirms]
      .flatMap((c) => [c.expected, ...transcriptTexts(c)])
      .flatMap(midSentenceCapitals)
      .filter((word) => !CONSTRUCTED_NAMES.has(word));
    expect(stray).toEqual([]);
  });

  it("keeps both fixtures under 100 KB", () => {
    const bytes = ["defects.golden.json", "metaphone.golden.json"].reduce(
      (sum, name) => sum + statSync(join(FIXTURES, name)).size,
      0,
    );
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });

  it("holds no AB chunk or book ids", () => {
    const all = ["defects.golden.json", "metaphone.golden.json"].map((n) => readFileSync(join(FIXTURES, n), "utf8")).join("\n");
    expect(all).not.toMatch(/\bb[67]c\d+-\d{3}\b|124774/);
  });
});
