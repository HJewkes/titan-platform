import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkMetrics, metricsCoverageGaps } from "./metrics-check.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => join(REPO, "scripts", "fixtures", "metrics", name);
const areas = [
  { id: "demo", tier: "product" },
  { id: "lib", tier: 1, path: "packages/lib" },
];

describe("pnpm metrics:check", () => {
  it("passes a valid entry for a known area", async () => {
    expect(await checkMetrics(fixture("valid"), areas)).toEqual([]);
  });

  it("fails an entry whose area is not in scripts/areas.mjs, naming the file", async () => {
    const errors = await checkMetrics(fixture("unknown-area"), areas);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("`metrics/ghost.yml` area: `ghost` is not an area");
  });

  it("fails an entry missing a required field, naming the file and the field", async () => {
    const errors = await checkMetrics(fixture("missing-field"), areas);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^`metrics\/demo\.yml` owner: /);
  });

  it("passes this repo's registry", async () => {
    const { loadAreas } = await import("./areas.mjs");
    expect(await checkMetrics(REPO, loadAreas(REPO))).toEqual([]);
  });
});

describe("metrics coverage", () => {
  it("names each product area with no entry and skips package areas", () => {
    const withGap = [...areas, { id: "other", tier: "product" }];
    expect(metricsCoverageGaps(fixture("valid"), withGap)).toEqual([
      "Product area `other` has no `metrics/other.yml`. Run a measurement audit and add its titan.metrics/v1 entry.",
    ]);
  });
});
