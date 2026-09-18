import { describe, it, expect } from "vitest";
import { diffAgainstProfile } from "./diff-against-profile.js";
import type { Profile } from "@titan-design/style-profile";
import type { Observation } from "@titan-design/style-analyzer";

const sampleProfile: Profile = {
  schemaVersion: "1.0.0",
  author: "testuser",
  generated: "2026-02-27",
  sources: [],
  naming: {
    variables: {
      convention: "camelCase",
      confidence: 0.94,
      stability: "high",
    },
  },
  structure: {},
  documentation: {},
  errorHandling: {},
  formatting: {},
  patterns: {},
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
};

describe("diffAgainstProfile", () => {
  it("reports no deviations when code matches profile", () => {
    const observations: Observation[] = [
      { type: "naming.variables", category: "naming", value: "camelCase", file: "src/app.ts", line: 5 },
      { type: "naming.variables", category: "naming", value: "camelCase", file: "src/app.ts", line: 12 },
    ];
    const result = diffAgainstProfile(sampleProfile, observations);
    expect(result.deviations).toHaveLength(0);
    expect(result.summary.total).toBe(2);
    expect(result.summary.matching).toBe(2);
  });

  it("reports deviations when code diverges from profile", () => {
    const observations: Observation[] = [
      { type: "naming.variables", category: "naming", value: "snake_case", file: "src/app.ts", line: 3 },
      { type: "naming.variables", category: "naming", value: "camelCase", file: "src/app.ts", line: 10 },
    ];
    const result = diffAgainstProfile(sampleProfile, observations);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]!.file).toBe("src/app.ts");
    expect(result.deviations[0]!.line).toBe(3);
    expect(result.deviations[0]!.expected).toBe("camelCase");
    expect(result.deviations[0]!.found).toBe("snake_case");
  });

  it("includes severity based on confidence thresholds", () => {
    const observations: Observation[] = [
      { type: "naming.variables", category: "naming", value: "snake_case", file: "src/app.ts", line: 1 },
    ];
    const result = diffAgainstProfile(sampleProfile, observations);
    expect(result.deviations[0]!.severity).toBe("error");
  });

  it("returns summary with deviation count", () => {
    const observations: Observation[] = [
      { type: "naming.variables", category: "naming", value: "snake_case", file: "a.ts", line: 1 },
      { type: "naming.variables", category: "naming", value: "PascalCase", file: "b.ts", line: 1 },
      { type: "naming.variables", category: "naming", value: "camelCase", file: "c.ts", line: 1 },
    ];
    const result = diffAgainstProfile(sampleProfile, observations);
    expect(result.summary.total).toBe(3);
    expect(result.summary.matching).toBe(1);
    expect(result.summary.deviating).toBe(2);
  });

  it("skips observations with no matching profile rule", () => {
    const observations: Observation[] = [
      { type: "naming.classes", category: "naming", value: "PascalCase", file: "a.ts", line: 1 },
    ];
    const result = diffAgainstProfile(sampleProfile, observations);
    expect(result.deviations).toHaveLength(0);
    expect(result.summary.total).toBe(1);
    expect(result.summary.matching).toBe(0);
    expect(result.summary.deviating).toBe(0);
  });

  it("uses the higher severity when confidence sits exactly on a threshold", () => {
    const atThreshold = (confidence: number): Profile => ({
      ...sampleProfile,
      naming: { variables: { convention: "camelCase", confidence, stability: "high" } },
    });
    const observations: Observation[] = [
      { type: "naming.variables", category: "naming", value: "snake_case", file: "a.ts", line: 1 },
    ];

    const atError = diffAgainstProfile(atThreshold(0.85), observations);
    const atWarn = diffAgainstProfile(atThreshold(0.6), observations);

    expect(atError.deviations[0]!.severity).toBe("error");
    expect(atWarn.deviations[0]!.severity).toBe("warn");
  });
});
