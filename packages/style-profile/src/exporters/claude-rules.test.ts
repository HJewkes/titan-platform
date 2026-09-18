import { describe, it, expect } from "vitest";
import { generateClaudeRules } from "./claude-rules.js";
import type { Profile } from "../schema/profile.js";

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
      description: "Use camelCase for all local variables.",
    },
    types: {
      convention: "PascalCase",
      confidence: 0.99,
      stability: "high",
    },
  },
  structure: {
    importOrder: {
      convention: ["builtin", "external", "internal", "relative"],
      confidence: 0.91,
    },
  },
  documentation: {},
  errorHandling: {},
  formatting: {},
  patterns: {},
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
};

describe("generateClaudeRules", () => {
  it("generates a typescript.md rules file", () => {
    const files = generateClaudeRules(sampleProfile);
    const tsRules = files.find((f) => f.path.endsWith("typescript.md"));
    expect(tsRules).toBeDefined();
  });

  it("includes path-scoped frontmatter with globs", () => {
    const files = generateClaudeRules(sampleProfile);
    const tsRules = files.find((f) => f.path.endsWith("typescript.md"))!;
    expect(tsRules.content).toContain("---");
    expect(tsRules.content).toMatch(/globs:.*\*\.ts/);
  });

  it("includes naming convention rules in body", () => {
    const files = generateClaudeRules(sampleProfile);
    const tsRules = files.find((f) => f.path.endsWith("typescript.md"))!;
    expect(tsRules.content).toContain("camelCase");
    expect(tsRules.content).toContain("PascalCase");
  });

  it("includes import ordering rules", () => {
    const files = generateClaudeRules(sampleProfile);
    const tsRules = files.find((f) => f.path.endsWith("typescript.md"))!;
    expect(tsRules.content).toContain("import");
  });

  it("only includes rules above info threshold", () => {
    const lowConfProfile: Profile = {
      ...sampleProfile,
      naming: {
        variables: {
          convention: "camelCase",
          confidence: 0.30,
          stability: "low",
        },
      },
      structure: {},
    };
    const files = generateClaudeRules(lowConfProfile);
    const tsRules = files.find((f) => f.path.endsWith("typescript.md"));
    if (tsRules) {
      expect(tsRules.content).not.toContain("camelCase");
    }
  });
});
