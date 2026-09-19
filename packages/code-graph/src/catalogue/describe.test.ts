import { describe, expect, it } from "vitest";
import { describeMetric, describeMetrics } from "./describe.js";
import { METRIC_CATALOGUE } from "./entries.js";

describe("describeMetric", () => {
  it("returns a fixed name's descriptor as catalogued", () => {
    expect(describeMetric("loc")).toMatchObject({ name: "loc", unit: "lines", rollup: "sum", appliesTo: ["file"] });
  });

  it("resolves a windowed name to a concrete descriptor carrying its window", () => {
    const d = describeMetric("churn_90d");
    expect(d).toMatchObject({ name: "churn_90d", window: "90d", unit: "lines", rollup: "sum" });
    expect(d?.description).toContain("90d window");
    expect(d).not.toHaveProperty("windowed");
  });

  it("keeps windowed names with a suffix apart from the bare windowed name", () => {
    expect(describeMetric("churn_lifetime_commits")).toMatchObject({ unit: "count", window: "lifetime" });
    expect(describeMetric("test_bus_factor_30d")?.source).toBe("test-linker");
    expect(describeMetric("bus_factor_30d")?.source).toBe("history");
  });

  it("returns null for a name nothing writes, including a bare template", () => {
    expect(describeMetric("churn_{w}")).toBeNull();
    expect(describeMetric("churn_week")).toBeNull();
    expect(describeMetric("lines")).toBeNull();
  });

  it("splits a name list into described and unknown, once per name", () => {
    const { described, unknown } = describeMetrics(["loc", "mystery", "loc", "recency_30d"]);
    expect(described.map((d) => d.name)).toEqual(["loc", "recency_30d"]);
    expect(unknown).toEqual(["mystery"]);
  });
});

describe("METRIC_CATALOGUE", () => {
  it("names each metric once", () => {
    const names = METRIC_CATALOGUE.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks exactly the templates that carry a window token as windowed", () => {
    for (const d of METRIC_CATALOGUE) expect(Boolean(d.windowed), d.name).toBe(d.name.includes("{w}"));
  });
});
