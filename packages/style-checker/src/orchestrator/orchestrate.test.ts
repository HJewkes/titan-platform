import { describe, it, expect, vi } from "vitest";
import { orchestrate } from "./orchestrate.js";
import { runRuff } from "../runners/ruff-runner.js";
import type { Profile } from "@titan-design/style-profile";

vi.mock("../runners/eslint-runner.js", () => ({
  runEslint: vi.fn().mockResolvedValue({
    diagnostics: [
      {
        file: "src/app.ts",
        line: 10,
        column: 7,
        severity: "error",
        message: "Naming violation",
        category: "naming",
        rule: "@typescript-eslint/naming-convention",
        fixable: false,
      },
    ],
    exitCode: 1,
    failures: [],
    skippedRules: [
      { tool: "eslint", rule: "unicorn/filename-case", plugin: "unicorn", reason: "not installed" },
    ],
  }),
}));

vi.mock("../runners/ruff-runner.js", () => ({
  runRuff: vi.fn().mockResolvedValue({
    diagnostics: [],
    exitCode: 0,
    failures: [],
    skippedRules: [],
  }),
}));

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
  severityThresholds: { error: 0.85, warn: 0.6, info: 0.4 },
};

describe("orchestrate", () => {
  it("runs ESLint for TypeScript files and returns unified diagnostics", async () => {
    const result = await orchestrate({
      profile: sampleProfile,
      files: ["src/app.ts"],
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.rule).toBe(
      "@typescript-eslint/naming-convention",
    );
    expect(result.summary.errors).toBe(1);
    expect(result.summary.total).toBe(1);
  });

  it("runs Ruff for Python files", async () => {
    const result = await orchestrate({
      profile: sampleProfile,
      files: ["src/app.py"],
      language: "python",
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("computes summary counts correctly", async () => {
    const result = await orchestrate({
      profile: sampleProfile,
      files: ["src/app.ts"],
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.errors).toBe(1);
    expect(result.summary.warnings).toBe(0);
    expect(result.summary.infos).toBe(0);
  });

  it("returns runner failures and skipped rules beside the diagnostics", async () => {
    const failure = { tool: "ruff" as const, kind: "spawn-failed" as const, message: "Failed to spawn ruff: ENOENT" };
    vi.mocked(runRuff).mockResolvedValueOnce({ diagnostics: [], exitCode: null, failures: [failure], skippedRules: [] });

    const result = await orchestrate({ profile: sampleProfile, files: ["src/app.ts", "app.py"] });

    expect(result.failures).toEqual([failure]);
    expect(result.skippedRules.map((s) => s.rule)).toEqual(["unicorn/filename-case"]);
    expect(result.summary.total).toBe(1);
  });
});
