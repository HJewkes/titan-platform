import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { microSignalArg, renderCommand, TargetSchema } from "./schemas.js";
import { proposal } from "./test-support/fake-ports.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "test-support", "fixtures");
const target = TargetSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "target.json"), "utf8")));

describe("rung command templates", () => {
  it("fills a target's seed rung from its own template", () => {
    const vars = { caseSet: target.caseSets["train-1"]!, case: "train-1", key: "run-1-r1", maxUsd: "1", runnerRoot: target.runnerRoot };

    expect(renderCommand(target.rungs.seed!.cmd, vars)).toEqual(["bash", "bench/suite/autoresearch/ar_eval.sh", "suite-a", "train-1", "run-1-r1", "1", ".", "--keep-lanes"]);
  });

  it("refuses a template token it has no value for", () => {
    expect(() => renderCommand(target.rungs["L1-cluster"]!.cmd, { runnerRoot: "." })).toThrow("[template] {caseSet}");
  });
});

describe("the micro signal argument", () => {
  it("appends the predicted direction to a bare count name and keeps one that names it", () => {
    expect(microSignalArg(proposal("x", { expectedEffect: { metric: "m", direction: "down", microSignal: "accepts" } }))).toBe("accepts:down");
    expect(microSignalArg(proposal("x", { expectedEffect: { metric: "m", direction: "down", microSignal: "accepts:up" } }))).toBe("accepts:up");
  });
});
