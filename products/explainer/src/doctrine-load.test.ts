import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VOCABULARY, craftRule, writeDoctrineDir } from "./doctrine-fixtures.test-helpers.js";
import { DEFAULT_DOCTRINE_DIR, loadDoctrine, parseEvidenceTsv } from "./doctrine-load.js";

const craft = (...rules: unknown[]) => ({ schema: "doctrine-craft/v1", rules });

describe("loadDoctrine", () => {
  it("merges every craft file with the vocabulary and ledger", () => {
    const story = craftRule({ id: "story-19", source: { doc: "story-structure", ref: "19" } });
    const dir = writeDoctrineDir({ "direction.yaml": craft(craftRule()), "story-structure.yaml": craft(story) });

    const registry = loadDoctrine(dir);

    expect(registry.rules.map((rule) => rule.id)).toEqual(["dir-P1", "story-19"]);
    expect(registry.vocabulary).toEqual(VOCABULARY);
    expect(registry.evidence.get("E03")).toEqual(["C", "D"]);
  });

  it("names the file and rule id when a rule fails its schema", () => {
    const dir = writeDoctrineDir({ "direction.yaml": craft(craftRule()), "bad.yaml": craft(craftRule({ id: "dir-P2", stages: [] })) });

    expect(() => loadDoctrine(dir)).toThrow(/craft\/bad\.yaml: dir-P2: stages/);
  });

  it("names the file when its header is wrong", () => {
    const dir = writeDoctrineDir({ "bad.yaml": { schema: "rules/v1", rules: [] } });

    expect(() => loadDoctrine(dir)).toThrow(/craft\/bad\.yaml/);
  });

  it("finds the shipped doctrine dir with no argument", () => {
    const registry = loadDoctrine();

    expect(existsSync(join(DEFAULT_DOCTRINE_DIR, "rules.yaml"))).toBe(true);
    expect(registry.vocabulary.types).toContain("repo-tour");
    expect(registry.evidence.get("E01")).toEqual(["A"]);
  });

  it("ships one ledger row per evidence id", () => {
    const text = readFileSync(join(DEFAULT_DOCTRINE_DIR, "evidence.tsv"), "utf8");
    const rows = text.split("\n").filter((line) => /^E\d+\t/.test(line));

    expect(parseEvidenceTsv(text).size).toBe(rows.length);
  });
});

describe("parseEvidenceTsv", () => {
  it("refuses a ledger with no grade column", () => {
    expect(() => parseEvidenceTsv("id\tclaim\nE01\tx")).toThrow(/grade/);
  });
});
