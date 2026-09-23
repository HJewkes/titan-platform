import { describe, it, expect } from "vitest";
import {
  canonicalMetricName,
  canonicalRole,
  canonicalEdgeKind,
  metricAliasTarget,
  roleAliasTarget,
} from "./aliases.js";

describe("canonicalMetricName", () => {
  it("heals deprecated metric spellings to the canonical name", () => {
    expect(canonicalMetricName("fan-in")).toBe("fan_in");
    expect(canonicalMetricName("fanout")).toBe("fan_out");
    expect(canonicalMetricName("lines")).toBe("loc");
    expect(canonicalMetricName("lines_of_code")).toBe("loc");
    expect(canonicalMetricName("nesting_depth")).toBe("max_nesting_depth");
    expect(canonicalMetricName("lcom4")).toBe("lcom4_max");
  });

  it("returns canonical names unchanged", () => {
    expect(canonicalMetricName("loc")).toBe("loc");
    expect(canonicalMetricName("cognitive_max")).toBe("cognitive_max");
  });

  it("passes through unknown names untouched", () => {
    expect(canonicalMetricName("not_a_metric")).toBe("not_a_metric");
  });
});

describe("canonicalRole", () => {
  it("heals deprecated role spellings", () => {
    expect(canonicalRole("tests")).toBe("test");
    expect(canonicalRole("spec")).toBe("test");
    expect(canonicalRole("fixtures")).toBe("fixture");
    expect(canonicalRole("barrels")).toBe("barrel");
  });

  it("returns canonical roles unchanged", () => {
    expect(canonicalRole("test")).toBe("test");
    expect(canonicalRole("source")).toBe("source");
  });
});

describe("canonicalEdgeKind", () => {
  it("heals deprecated edge-kind spellings", () => {
    expect(canonicalEdgeKind("import")).toBe("imports");
    expect(canonicalEdgeKind("call")).toBe("calls");
    expect(canonicalEdgeKind("re_exports")).toBe("re-exports");
    expect(canonicalEdgeKind("depends_on")).toBe("depends-on");
  });

  it("returns canonical edge kinds unchanged", () => {
    expect(canonicalEdgeKind("imports")).toBe("imports");
    expect(canonicalEdgeKind("re-exports")).toBe("re-exports");
  });
});

describe("alias-target probes", () => {
  it("metricAliasTarget reports the canonical name only for deprecated aliases", () => {
    expect(metricAliasTarget("fan-in")).toBe("fan_in");
    expect(metricAliasTarget("loc")).toBeUndefined();
    expect(metricAliasTarget("nonsense")).toBeUndefined();
  });

  it("roleAliasTarget reports the canonical role only for deprecated aliases", () => {
    expect(roleAliasTarget("tests")).toBe("test");
    expect(roleAliasTarget("test")).toBeUndefined();
    expect(roleAliasTarget("nonsense")).toBeUndefined();
  });
});
