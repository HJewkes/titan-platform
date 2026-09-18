import { describe, it, expect } from "vitest";
import { StyleRuleSchema, type StyleRule } from "./style-rule.js";
import { ProfileSchema, SCHEMA_VERSION, type Profile } from "./profile.js";

describe("StyleRule", () => {
  it("validates a complete style rule", () => {
    const rule: StyleRule = {
      convention: "camelCase",
      confidence: 0.94,
      stability: "high",
      fixability: "maybe-incorrect",
      description: "Use camelCase for local variables",
      examples: [
        {
          good: "const userProfile = await fetchUser(id);",
          source: "repo-a/src/users.ts:42",
        },
        { bad: "const up = await fetchUser(id);" },
      ],
      extensions: {
        eslint: {
          rule: "@typescript-eslint/naming-convention",
          options: [{ selector: "variable", format: ["camelCase"] }],
        },
      },
    };

    const result = StyleRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });

  it("validates a minimal style rule", () => {
    const rule = {
      convention: "camelCase",
      confidence: 0.94,
    };

    const result = StyleRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });

  it("rejects confidence outside 0-1 range", () => {
    const rule = { convention: "camelCase", confidence: 1.5 };
    const result = StyleRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
  });

  it("rejects invalid stability value", () => {
    const rule = { convention: "camelCase", confidence: 0.8, stability: "extreme" };
    const result = StyleRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
  });

  it("rejects invalid fixability value", () => {
    const rule = { convention: "camelCase", confidence: 0.8, fixability: "auto" };
    const result = StyleRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
  });
});

describe("Profile", () => {
  it("validates a complete profile", () => {
    const profile: Profile = {
      $schema: "https://json.schemastore.org/code-style-profile.json",
      schemaVersion: SCHEMA_VERSION,
      author: "testuser",
      generated: "2026-02-27",
      sources: ["owner/repo-a", "owner/repo-b"],
      naming: {
        variables: { convention: "camelCase", confidence: 0.94, stability: "high" },
        functions: { convention: "camelCase", confidence: 0.97, stability: "high" },
        types: { convention: "PascalCase", confidence: 0.99, stability: "high" },
      },
      structure: {
        importOrder: {
          convention: ["builtin", "external", "internal", "relative"],
          confidence: 0.91,
          fixability: "safe",
        },
      },
      documentation: {
        functionDocs: { convention: "jsdoc-selective", confidence: 0.80 },
      },
      errorHandling: {
        style: { convention: "return-errors", confidence: 0.72, stability: "high" },
      },
      formatting: {
        semicolons: { convention: true, confidence: 0.99, stability: "high", fixability: "safe" },
      },
      patterns: {},
      idioms: { detected: [] },
      antiPatterns: { acknowledged: [] },
      overrides: [],
      severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
    };

    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it("applies default severity thresholds when omitted", () => {
    const profile = {
      schemaVersion: SCHEMA_VERSION,
      author: "testuser",
      generated: "2026-02-27",
      sources: [],
      naming: {},
      structure: {},
      documentation: {},
      errorHandling: {},
      formatting: {},
      patterns: {},
      idioms: { detected: [] },
      antiPatterns: { acknowledged: [] },
      overrides: [],
    };

    const result = ProfileSchema.parse(profile);
    expect(result.severityThresholds).toEqual({
      error: 0.85,
      warn: 0.60,
      info: 0.40,
    });
  });

  it("rejects missing required top-level fields", () => {
    const result = ProfileSchema.safeParse({ schemaVersion: "1.0.0" });
    expect(result.success).toBe(false);
  });
});
