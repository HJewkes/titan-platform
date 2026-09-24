import { describe, it, expect } from "vitest";
import { validateRules } from "./validate.js";
import type { CheckRule, MetricMaxRule, MetricProductMaxRule } from "./types.js";

describe("validateRules", () => {
  it("rejects non-object input", () => {
    expect(() => validateRules(null)).toThrow();
    expect(() => validateRules("hi")).toThrow();
  });

  it("rejects rules without id, type, or required fields", () => {
    expect(() => validateRules({ rules: [{ type: "metric-max" }] })).toThrow(/id/);
    expect(() => validateRules({ rules: [{ id: "r" }] })).toThrow(/type/);
    expect(() => validateRules({ rules: [{ id: "r", type: "metric-max", metric: "loc" }] })).toThrow(/max/);
    expect(() => validateRules({ rules: [{ id: "r", type: "unknown" }] })).toThrow(/unknown type/);
  });

  it("validates and returns normalized rules", () => {
    const rules = validateRules({
      rules: [
        { id: "a", type: "metric-max", metric: "loc", max: 100, exclude: ["t"] },
        { id: "b", type: "forbid-import", from: "x/**", to: "y/**" },
      ],
    }) as CheckRule[];
    expect(rules).toHaveLength(2);
    expect(rules[0]!.type).toBe("metric-max");
    expect(rules[1]!.type).toBe("forbid-import");
  });

  it("rejects layered-deps with fewer than 2 layers", () => {
    expect(() =>
      validateRules({
        rules: [{ id: "r", type: "layered-deps", layers: [["core"]] }],
      }),
    ).toThrow(/2\+/);
  });

  it("rejects layered-deps with a package in multiple layers", () => {
    expect(() =>
      validateRules({
        rules: [
          {
            id: "r",
            type: "layered-deps",
            layers: [["core"], ["analyzer", "core"]],
          },
        ],
      }),
    ).toThrow(/"core" appears in more than one layer/);
  });

  it("rejects unknown role values in excludeRoles", () => {
    expect(() =>
      validateRules({
        rules: [
          {
            id: "r",
            type: "metric-max",
            metric: "loc",
            max: 1,
            excludeRoles: ["banana"],
          },
        ],
      }),
    ).toThrow(/unknown role/);
  });

  it("rejects metric-product-max with fewer than 2 metrics or non-string entries", () => {
    expect(() =>
      validateRules({
        rules: [{ id: "r", type: "metric-product-max", metrics: ["a"], max: 1 }],
      }),
    ).toThrow(/2\+/);
    expect(() =>
      validateRules({
        rules: [
          { id: "r", type: "metric-product-max", metrics: ["a", 7], max: 1 },
        ],
      }),
    ).toThrow(/strings/);
  });

  it("rejects no-internal-only-barrels without packageRoots", () => {
    expect(() =>
      validateRules({
        rules: [{ id: "r", type: "no-internal-only-barrels" }],
      }),
    ).toThrow(/packageRoots/);
    expect(() =>
      validateRules({
        rules: [
          { id: "r", type: "no-internal-only-barrels", packageRoots: [] },
        ],
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      validateRules({
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots: ["packages/a", ""],
          },
        ],
      }),
    ).toThrow(/non-empty/);
  });

  it("normalizes a metric-product-max rule", () => {
    const [rule] = validateRules({
      rules: [
        {
          id: "scary",
          type: "metric-product-max",
          metrics: ["churn_30d", "cyclomatic_max"],
          max: 1000,
          kind: "file",
          exclude: ["__tests__"],
        },
      ],
    });
    expect(rule).toEqual({
      type: "metric-product-max",
      id: "scary",
      metrics: ["churn_30d", "cyclomatic_max"],
      max: 1000,
      kind: "file",
      severity: undefined,
      exclude: ["__tests__"],
    });
  });

  it("normalizes a metric-outlier rule", () => {
    const [rule] = validateRules({
      rules: [{ id: "long", type: "metric-outlier", metric: "symbol_loc", kind: "symbol", percentile: 95, minSample: 30, severity: "warning" }],
    });
    expect(rule).toEqual({
      type: "metric-outlier",
      id: "long",
      metric: "symbol_loc",
      kind: "symbol",
      percentile: 95,
      minSample: 30,
      severity: "warning",
    });
  });

  it("rejects a metric-outlier rule with a bad metric, kind, percentile or minSample", () => {
    const base = { id: "r", type: "metric-outlier", metric: "loc", kind: "file", percentile: 90 };
    const bad = (patch: Record<string, unknown>) => () => validateRules({ rules: [{ ...base, ...patch }] });
    expect(bad({})).not.toThrow();
    expect(bad({ metric: 3 })).toThrow(/metric must be a string/);
    expect(bad({ kind: undefined })).toThrow(/kind must be one of/);
    expect(bad({ kind: "directory" })).toThrow(/kind must be one of/);
    expect(bad({ percentile: 49 })).toThrow(/percentile must be a number from 50 to 100/);
    expect(bad({ percentile: 101 })).toThrow(/percentile/);
    expect(bad({ percentile: "90" })).toThrow(/percentile/);
    expect(bad({ minSample: 0 })).toThrow(/minSample must be a positive integer/);
    expect(bad({ minSample: 2.5 })).toThrow(/minSample/);
    expect(bad({ floor: -1 })).toThrow(/floor must be a non-negative finite number/);
    expect(bad({ rankNonZero: "yes" })).toThrow(/rankNonZero must be a boolean/);
  });

  it("normalizes a metric-outlier rule with floor and rankNonZero", () => {
    const [rule] = validateRules({
      rules: [{ id: "long", type: "metric-outlier", metric: "symbol_loc", kind: "symbol", percentile: 90, floor: 0.5, rankNonZero: true }],
    });
    expect(rule).toMatchObject({ floor: 0.5, rankNonZero: true });
  });
});

describe("validateRules — schema healing", () => {
  it("heals a deprecated metric name and warns instead of erroring", () => {
    const warnings: string[] = [];
    const [rule] = validateRules(
      {
        rules: [{ id: "r", type: "metric-max", metric: "fan-in", max: 10 }],
      },
      { onWarn: (m) => warnings.push(m) },
    ) as MetricMaxRule[];
    expect(rule!.metric).toBe("fan_in");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fan-in.*deprecated.*fan_in/);
  });

  it("heals deprecated metric names inside metric-product-max", () => {
    const warnings: string[] = [];
    const [rule] = validateRules(
      {
        rules: [
          {
            id: "r",
            type: "metric-product-max",
            metrics: ["lines", "cognitive_max"],
            max: 1000,
          },
        ],
      },
      { onWarn: (m) => warnings.push(m) },
    ) as MetricProductMaxRule[];
    expect(rule!.metrics).toEqual(["loc", "cognitive_max"]);
    expect(warnings).toHaveLength(1);
  });

  it("heals a deprecated role alias and warns instead of erroring", () => {
    const warnings: string[] = [];
    const [rule] = validateRules(
      {
        rules: [
          {
            id: "r",
            type: "metric-max",
            metric: "loc",
            max: 1,
            excludeRoles: ["tests", "fixtures"],
          },
        ],
      },
      { onWarn: (m) => warnings.push(m) },
    ) as MetricMaxRule[];
    expect(rule!.excludeRoles).toEqual(["test", "fixture"]);
    expect(warnings).toHaveLength(2);
  });

  it("still throws on a genuinely-unknown role", () => {
    expect(() =>
      validateRules({
        rules: [
          {
            id: "r",
            type: "metric-max",
            metric: "loc",
            max: 1,
            excludeRoles: ["banana"],
          },
        ],
      }),
    ).toThrow(/unknown role/);
  });

  it("does not warn when every name is already canonical", () => {
    const warnings: string[] = [];
    validateRules(
      {
        rules: [
          {
            id: "r",
            type: "metric-max",
            metric: "loc",
            max: 1,
            excludeRoles: ["test"],
          },
        ],
      },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(warnings).toEqual([]);
  });
});
