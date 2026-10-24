import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { narrativeStructure, PROFILE_VOCABULARY, STRUCTURES } from "./profile-fixtures.test-helpers.js";
import { loadStructures, structureFor, UnknownStructureError } from "./profile-load.js";
import { checkStructures, type StructureIssueCode } from "./structure-checks.js";
import type { NarrativeStructure } from "./structure-schema.js";

const codes = (...extra: NarrativeStructure[]): StructureIssueCode[] => {
  const structures = new Map([...STRUCTURES, ...extra.map((structure): [string, NarrativeStructure] => [structure.id, structure])]);
  return checkStructures(structures, PROFILE_VOCABULARY).map((found) => found.code);
};

const replacing = (id: string, overrides: Partial<NarrativeStructure>): NarrativeStructure => ({ ...structureFor(STRUCTURES, id), ...overrides });

function writeStructures(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "structures-"));
  mkdirSync(join(dir, "structures"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "structures", name), stringify(body));
  return dir;
}

describe("checkStructures", () => {
  it("finds nothing in the sound fixture registry", () => {
    expect(codes()).toEqual([]);
  });

  it.each<[string, NarrativeStructure, StructureIssueCode]>([
    ["a structure missing from the vocabulary", narrativeStructure("freytag", { all: ["problem"] }), "unknown-vocabulary"],
    ["a fit signal missing from the vocabulary", replacing("abt", { fit: { ...structureFor(STRUCTURES, "abt").fit, none: ["onboarding"] } }), "unknown-signal"],
    ["block shares that do not sum to 1", replacing("abt", { blocks: [{ id: "open", goal: "g", share: 0.5 }, { id: "close", goal: "g", share: 0.4 }] }), "share-sum"],
    ["a fit runtime minimum above its maximum", replacing("abt", { fit: { ...structureFor(STRUCTURES, "abt").fit, minRuntimeS: 300, maxRuntimeS: 200 } }), "runtime-order"],
    ["a block listed twice", replacing("abt", { blocks: [{ id: "open", goal: "g", share: 0.5 }, { id: "open", goal: "g", share: 0.5 }] }), "duplicate-block"],
  ])("reports %s", (_name, structure, code) => {
    expect(codes(structure)).toEqual([code]);
  });

  it("reports a vocabulary structure with no file", () => {
    const structures = new Map([...STRUCTURES].filter(([id]) => id !== "mystery"));

    expect(checkStructures(structures, PROFILE_VOCABULARY).map((found) => found.code)).toEqual(["missing-structure"]);
  });

  it("finds nothing in the shipped structures against the shipped vocabulary", () => {
    expect(checkStructures(loadStructures(), loadDoctrine().vocabulary)).toEqual([]);
  });
});

describe("loadStructures", () => {
  it("loads the shipped registry, design-journey among it", () => {
    const ids = [...loadStructures().keys()];

    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids).toContain("design-journey");
  });

  it("rejects an unknown structure, naming the known ones", () => {
    expect(() => structureFor(loadStructures(), "freytag")).toThrow(UnknownStructureError);
    expect(() => structureFor(loadStructures(), "freytag")).toThrow(/known: .*design-journey/);
  });

  it("rejects a file whose name differs from its id", () => {
    const dir = writeStructures({ "abt-short.yaml": narrativeStructure("abt", { all: ["problem"] }) });

    expect(() => loadStructures(dir)).toThrow("structures/abt-short.yaml: names abt, so the file is abt.yaml");
  });

  it("rejects a shape error, naming the file", () => {
    const dir = writeStructures({ "abt.yaml": { ...narrativeStructure("abt", { all: ["problem"] }), spine: [] } });

    expect(() => loadStructures(dir)).toThrow(/structures\/abt\.yaml: .*spine/s);
  });
});
