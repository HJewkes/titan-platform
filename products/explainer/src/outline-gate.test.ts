import { describe, expect, it } from "vitest";
import { outlineIssues } from "./outline-gate.js";

const profile = { runtime: { targetS: 240, minS: 120, maxS: 360, splitAboveS: 360 } };
const GOOD = "Builds are slow, but the cache keys steps, so reruns are free.";
const spine = (seconds: number[], sentence = GOOD) => ({ sentence, blocks: seconds.map((s) => ({ seconds: s })) });

describe("outline gate", () => {
  it("a spine inside the runtime band with an ABT sentence passes", () => {
    expect(outlineIssues(spine([60, 60, 60]), profile)).toEqual([]);
  });

  it("a spine 90 s long against a 120 s floor fails naming both numbers", () => {
    const issues = outlineIssues(spine([30, 30, 30]), profile);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("90");
    expect(issues[0]).toContain("120");
  });

  it("a spine past the ceiling fails naming both numbers", () => {
    const issues = outlineIssues(spine([200, 200]), profile);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("400");
    expect(issues[0]).toContain("360");
  });

  it("a sentence with only 'but' fails naming the missing consequential turn", () => {
    const issues = outlineIssues(spine([60, 60, 60], "Builds are slow, but the cache helps."), profile);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/consequential/);
    expect(issues[0]).not.toMatch(/contrastive/);
  });

  it("a sentence with neither turn names both", () => {
    const issues = outlineIssues(spine([60, 60, 60], "The desk refuses ghost labels."), profile);

    expect(issues.join(" ")).toMatch(/contrastive/);
    expect(issues.join(" ")).toMatch(/consequential/);
  });
});
