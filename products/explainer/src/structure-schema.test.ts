import { describe, expect, it } from "vitest";
import { narrativeStructure } from "./profile-fixtures.test-helpers.js";
import { loadStructures, structureFor } from "./profile-load.js";
import { fits, NarrativeStructureSchema, renderSpine } from "./structure-schema.js";

const at = (runtimeS: number, ...signals: string[]) => ({ signals: new Set(signals), runtimeS });

describe("fits", () => {
  const elegant = narrativeStructure("kishotenketsu", { all: ["elegant-idea"], none: ["central-problem"] });
  const decision = narrativeStructure("scqa", { any: ["decision-pending", "owner-gate"] });
  const long = narrativeStructure("three-act", { all: ["central-problem"], minRuntimeS: 300, maxRuntimeS: 600 });

  it.each<[string, ReturnType<typeof narrativeStructure>, ReturnType<typeof at>, boolean]>([
    ["every all signal holds", elegant, at(240, "elegant-idea"), true],
    ["an all signal is missing", elegant, at(240), false],
    ["a none signal holds", elegant, at(240, "elegant-idea", "central-problem"), false],
    ["one any signal holds", decision, at(240, "owner-gate"), true],
    ["no any signal holds", decision, at(240, "anomaly"), false],
    ["the runtime is at the minimum", long, at(300, "central-problem"), true],
    ["the runtime is under the minimum", long, at(299, "central-problem"), false],
    ["the runtime is at the maximum", long, at(600, "central-problem"), true],
    ["the runtime is over the maximum", long, at(601, "central-problem"), false],
  ])("is %s → %s", (_name, structure, input, expected) => {
    expect(fits(structure, input)).toBe(expected);
  });
});

describe("NarrativeStructureSchema", () => {
  it("rejects a fit predicate that names no signal", () => {
    expect(NarrativeStructureSchema.safeParse(narrativeStructure("abt", { none: ["anomaly"] })).success).toBe(false);
  });

  it("rejects a field it does not know", () => {
    expect(NarrativeStructureSchema.safeParse({ ...narrativeStructure("abt", { all: ["anomaly"] }), ownerPick: true }).success).toBe(false);
  });
});

describe("the design-journey structure", () => {
  const spine = renderSpine(structureFor(loadStructures(), "design-journey"));

  it("keeps the spine/v1 section numbers that lint-spine reads its tables from", () => {
    const headings = spine.split("\n").filter((line) => line.startsWith("## "));

    expect(headings.map((line) => line.replace(/^## (\d+)\. (\S+).*$/, "$1 $2"))).toEqual([
      "1 Viewer",
      "2 Problem",
      "3 Journey:",
      "4 Architecture",
      "5 Constraints",
      "6 Item",
      "7 Cut",
      "8 Chapter",
      "9 List",
    ]);
  });

  it("renders as a fillable template under the spine title", () => {
    expect(spine.startsWith("# Story spine: <video id>\n\n## 1. Viewer\n- Who: <persona>.")).toBe(true);
    expect(spine).toContain("| # | Step | What happens (one clause) |");
    expect(spine.endsWith("so they are never compared.")).toBe(true);
  });
});
