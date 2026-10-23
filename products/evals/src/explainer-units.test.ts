import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHA256_PATTERN } from "./spec/common.js";
import { parseSpec } from "./spec/index.js";
import { validateSpec } from "./validate.js";

const UNITS = fileURLToPath(new URL("../units/", import.meta.url));
const STAGE_UNITS = readdirSync(UNITS).filter((dir) => dir.startsWith("explainer-") && dir !== "explainer-video").sort();
const ALL_UNITS = [...STAGE_UNITS, "explainer-video"];

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const caseFiles = (unit: string): string[] => readdirSync(join(UNITS, unit, "cases")).map((file) => join(UNITS, unit, "cases", file));
const specFiles = (unit: string): string[] =>
  [join(UNITS, unit, "unit.json"), join(UNITS, unit, "suite.json"), join(UNITS, unit, "variants", "champion.json"), ...caseFiles(unit)];

function caseOf(file: string) {
  const spec = parseSpec(readJson(file), "strict");
  if (spec.schema !== "titan.case/v1") throw new Error(`${file} is not a case`);
  return spec;
}

describe("explainer units", () => {
  it("has one unit per stage of the explainer.<stage> child workflows", () => {
    expect(STAGE_UNITS).toEqual(["explainer-eval", "explainer-qa", "explainer-render", "explainer-rewrite", "explainer-script", "explainer-sheets", "explainer-tts"]);
  });

  it("strict-validates every unit, variant, case and suite file with no stale prompt digest", async () => {
    for (const unit of ALL_UNITS) {
      for (const file of specFiles(unit)) {
        const result = await validateSpec(readJson(file), (path) => readFile(join(UNITS, unit, path)));
        expect(result.stalePrompts, file).toBe(false);
      }
    }
  });

  it("lists in each suite exactly the hashes of the unit's case files", async () => {
    for (const unit of ALL_UNITS) {
      const suite = parseSpec(readJson(join(UNITS, unit, "suite.json")), "strict");
      const hashes = await Promise.all(caseFiles(unit).map(async (file) => (await validateSpec(readJson(file), () => Promise.reject(new Error("no prompts")))).hash));
      expect(suite.schema === "titan.suite/v1" && suite.cases, unit).toEqual(hashes.sort());
    }
  });

  it("puts every owner-named case in the holdout", () => {
    const owned = ALL_UNITS.flatMap(caseFiles).map(caseOf).filter((c) => c.tags.includes("owner-named"));

    expect(owned.length).toBeGreaterThan(0);
    expect(owned.filter((c) => c.split !== "holdout").map((c) => `${c.unit.id}/${c.id}`)).toEqual([]);
  });

  it("freezes cases as artifact shas only, so no script text or fact reaches this public repo", () => {
    const leaks = ALL_UNITS.flatMap(caseFiles).map(caseOf).flatMap((c) => {
      const { inputs, ...rest } = c.input as { inputs: Record<string, string>; files?: Record<string, string> };
      const bad = Object.entries(inputs).filter(([, sha]) => !SHA256_PATTERN.test(sha)).map(([name]) => name);
      const extra = Object.keys(rest).filter((key) => key !== "files");
      return [...bad, ...extra].map((name) => `${c.unit.id}/${c.id}: ${name}`);
    });

    expect(leaks).toEqual([]);
  });

  it("names every stage unit as a child of explainer-video", () => {
    const parent = parseSpec(readJson(join(UNITS, "explainer-video", "unit.json")), "strict");

    expect(parent.schema === "titan.unit/v1" && parent.children?.map((child) => child.id).sort()).toEqual(STAGE_UNITS);
  });
});
