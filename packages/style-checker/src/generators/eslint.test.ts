import { describe, it, expect } from "vitest";
import { generateEslintConfig } from "./eslint.js";
import type { Profile } from "@titan-design/style-profile";

const baseProfile: Profile = {
  schemaVersion: "1.0.0",
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
  severityThresholds: { error: 0.85, warn: 0.6, info: 0.4 },
};

const sampleProfile: Profile = {
  ...baseProfile,
  naming: {
    variables: {
      convention: "camelCase",
      confidence: 0.94,
      stability: "high",
      fixability: "maybe-incorrect",
      extensions: {
        eslint: {
          rule: "@typescript-eslint/naming-convention",
          options: [{ selector: "variable", format: ["camelCase"] }],
        },
      },
    },
    types: {
      convention: "PascalCase",
      confidence: 0.99,
      stability: "high",
      extensions: {
        eslint: {
          rule: "@typescript-eslint/naming-convention",
          options: [{ selector: "typeLike", format: ["PascalCase"] }],
        },
      },
    },
    files: {
      convention: "kebab-case",
      confidence: 0.88,
      stability: "high",
    },
  },
  structure: {
    importOrder: {
      convention: ["builtin", "external", "internal", "relative"],
      confidence: 0.91,
      fixability: "safe",
    },
    functionMaxLines: {
      convention: 28,
      confidence: 0.78,
    },
  },
  documentation: {
    functionDocs: {
      convention: "jsdoc-selective",
      confidence: 0.8,
    },
  },
};

describe("generateEslintConfig", () => {
  it("generates a flat config array", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    expect(entries).toBeDefined();
    expect(Array.isArray(entries)).toBe(true);
  });

  it("maps naming conventions to @typescript-eslint/naming-convention", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    const rulesConfig = entries.find(
      (c) => c.rules?.["@typescript-eslint/naming-convention"],
    );
    expect(rulesConfig).toBeDefined();
    const rule = rulesConfig!.rules!["@typescript-eslint/naming-convention"];
    expect(rule).toBeDefined();
  });

  it("sets severity based on confidence thresholds", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    const rulesConfig = entries.find(
      (c) => c.rules?.["@typescript-eslint/naming-convention"],
    );
    const rule = rulesConfig!.rules![
      "@typescript-eslint/naming-convention"
    ] as unknown[];
    expect(rule[0]).toBe("error");
  });

  it("maps import ordering to perfectionist plugin", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    const rulesConfig = entries.find(
      (c) => c.rules?.["perfectionist/sort-imports"],
    );
    expect(rulesConfig).toBeDefined();
  });

  it("maps function max lines to max-lines-per-function", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    const rulesConfig = entries.find(
      (c) => c.rules?.["max-lines-per-function"],
    );
    expect(rulesConfig).toBeDefined();
    const rule = rulesConfig!.rules!["max-lines-per-function"] as unknown[];
    expect(rule).toContainEqual(expect.objectContaining({ max: 28 }));
  });

  it("maps file naming to unicorn/filename-case", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    const rulesConfig = entries.find(
      (c) => c.rules?.["unicorn/filename-case"],
    );
    expect(rulesConfig).toBeDefined();
  });

  it("maps documentation rules to eslint-plugin-jsdoc", () => {
    const { entries } = generateEslintConfig(sampleProfile);
    const rulesConfig = entries.find((c) =>
      Object.keys(c.rules ?? {}).some((r) => r.startsWith("jsdoc/")),
    );
    expect(rulesConfig).toBeDefined();
  });

  it("omits rules below info threshold", () => {
    const lowConfProfile: Profile = {
      ...baseProfile,
      naming: {
        variables: {
          convention: "camelCase",
          confidence: 0.3,
          stability: "low",
        },
      },
    };
    const { entries } = generateEslintConfig(lowConfProfile);
    const rulesConfig = entries.find(
      (c) => c.rules?.["@typescript-eslint/naming-convention"],
    );
    expect(rulesConfig).toBeUndefined();
  });

  it("emits the info tier as warn, because ESLint rejects any other severity", () => {
    const infoProfile: Profile = {
      ...baseProfile,
      naming: { variables: { convention: "camelCase", confidence: 0.5, stability: "low" } },
    };
    const { entries } = generateEslintConfig(infoProfile);
    const rule = entries[0]!.rules!["@typescript-eslint/naming-convention"] as unknown[];
    expect(rule[0]).toBe("warn");
  });

  it("forwards an unmapped naming convention as a skipped rule, and still emits the rest of the config", () => {
    const profile: Profile = {
      ...baseProfile,
      naming: {
        variables: { convention: "kebab-case", confidence: 0.9, stability: "high" },
        types: { convention: "PascalCase", confidence: 0.9, stability: "high" },
      },
    };
    const { entries, skippedRules } = generateEslintConfig(profile);

    expect(skippedRules).toEqual([{
      tool: "eslint",
      rule: "@typescript-eslint/naming-convention",
      plugin: "@typescript-eslint",
      reason: expect.stringContaining('naming.variables convention "kebab-case"'),
    }]);
    const rule = entries[0]!.rules!["@typescript-eslint/naming-convention"];
    expect(rule).toEqual(["error", { selector: "typeLike", format: ["PascalCase"] }]);
  });
});
