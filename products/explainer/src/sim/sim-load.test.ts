import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { SIM_MODELS } from "./model.js";
import { fairCoinRetry, fixedGeometric, mathRandomModel, toySpec } from "./sim-fixtures.test-helpers.js";
import { checkSims, loadSims, simDoctrineSha, SimModelSpecSchema } from "./sim-load.js";

function simsDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sims-"));
  mkdirSync(join(dir, "sims"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "sims", name), stringify(body));
  return dir;
}

describe("loadSims", () => {
  it("reads each sims/<id>.yaml keyed by id", () => {
    const dir = simsDir({ "fair-coin-retry.yaml": toySpec("fair-coin-retry") });

    const specs = loadSims(dir);

    expect([...specs.keys()]).toEqual(["fair-coin-retry"]);
    expect(specs.get("fair-coin-retry")?.statistics["mean-tries"]?.tolerance).toEqual({ rel: 0.05 });
  });

  it("names the file when fittedFrom lists a statistic the file does not declare", () => {
    const dir = simsDir({ "fair-coin-retry.yaml": { ...toySpec("fair-coin-retry"), fittedFrom: ["share-tail"] } });

    expect(() => loadSims(dir)).toThrow(/sims\/fair-coin-retry\.yaml: .*share-tail/s);
  });

  it("rejects a tolerance that is both abs and rel, and a default outside its bounds", () => {
    const both = { ...toySpec("fair-coin-retry"), statistics: { "mean-tries": { tolerance: { abs: 0.1, rel: 0.05 }, why: "Synthetic." } } };
    const outside = toySpec("fair-coin-retry");
    outside.params.p = { default: 2, min: 0, max: 1 };

    expect(SimModelSpecSchema.safeParse(both).success).toBe(false);
    expect(SimModelSpecSchema.safeParse(outside).success).toBe(false);
  });

  it("gives a different doctrine sha when a tolerance changes", () => {
    const loose = toySpec("fair-coin-retry");
    const tight = toySpec("fair-coin-retry");
    tight.statistics["mean-tries"] = { tolerance: { rel: 0.02 }, why: "Synthetic tolerance." };

    expect(simDoctrineSha(tight)).not.toBe(simDoctrineSha(loose));
  });
});

describe("checkSims", () => {
  it("passes a model whose doctrine file matches it", () => {
    const specs = new Map([["fair-coin-retry", toySpec("fair-coin-retry")]]);

    expect(checkSims({ "fair-coin-retry": fairCoinRetry }, specs)).toEqual([]);
  });

  it("reports a model with no doctrine file and a doctrine file with no model", () => {
    const specs = new Map([["fair-coin-retry", toySpec("fair-coin-retry")]]);

    const issues = checkSims({ "fixed-geometric": fixedGeometric }, specs);

    expect(issues.map((issue) => [issue.code, issue.model])).toEqual([
      ["E-SIM-NO-DOCTRINE", "fixed-geometric"],
      ["E-SIM-NO-MODEL", "fair-coin-retry"],
    ]);
  });

  it("reports a doctrine statistic the model never emits", () => {
    const specs = new Map([["fixed-geometric", toySpec("fixed-geometric", ["mean-tries", "share-tail"])]]);

    const issues = checkSims({ "fixed-geometric": fixedGeometric }, specs);

    expect(issues).toEqual([expect.objectContaining({ code: "E-SIM-STAT-UNEMITTED", model: "fixed-geometric", message: expect.stringContaining("share-tail") })]);
  });

  it("refuses an impure model while checking it", () => {
    const specs = new Map([["math-random", { ...toySpec("math-random", ["draw"]), id: "math-random" }]]);

    expect(() => checkSims({ "math-random": mathRandomModel }, specs)).toThrow(/Math\.random/);
  });

  it("finds the shipped code registry and doctrine registry in step", () => {
    expect(checkSims(SIM_MODELS, loadSims())).toEqual([]);
  });
});
