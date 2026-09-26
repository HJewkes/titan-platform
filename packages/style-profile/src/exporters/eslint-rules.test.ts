import { describe, it, expect } from "vitest";
import { ESLint, type Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import { buildNamingConvention } from "./eslint-rules.js";
import type { Profile } from "../schema/profile.js";
import type { StyleRule } from "../schema/style-rule.js";

function makeProfile(naming: Record<string, StyleRule>): Profile {
  return {
    schemaVersion: "1.0.0",
    author: "testuser",
    generated: "2026-09-26",
    sources: [],
    naming,
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
}

function naming(convention: StyleRule["convention"], confidence = 0.9): StyleRule {
  return { convention, confidence };
}

async function lintWithRule(rule: [string, unknown], code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{
      files: ["**/*.ts"],
      languageOptions: { parser: tsParser },
      plugins: { "@typescript-eslint": tsPlugin as unknown as ESLint.Plugin },
      rules: { [rule[0]]: rule[1] } as Linter.RulesRecord,
    }],
  });
  const [result] = await eslint.lintText(code, { filePath: "fixture.ts" });
  return result!;
}

describe("buildNamingConvention format mapping", () => {
  it.each([
    ["camelCase", "camelCase"],
    ["strictCamelCase", "strictCamelCase"],
    ["PascalCase", "PascalCase"],
    ["StrictPascalCase", "StrictPascalCase"],
    ["snake_case", "snake_case"],
    ["UPPER_CASE", "UPPER_CASE"],
    ["UPPER_SNAKE_CASE", "UPPER_CASE"],
    ["SCREAMING_SNAKE", "UPPER_CASE"],
    ["SCREAMING_SNAKE_CASE", "UPPER_CASE"],
  ])("emits typescript-eslint format %s as %s", (profileValue, format) => {
    const { rule, skippedRules } = buildNamingConvention(makeProfile({ constants: naming(profileValue) }));

    expect(rule).toEqual(["@typescript-eslint/naming-convention", ["error", { selector: "variable", format: [format] }]]);
    expect(skippedRules).toEqual([]);
  });

  it("skips a naming value typescript-eslint has no format for, with a reason", () => {
    const profile = makeProfile({ variables: naming("kebab-case"), types: naming("PascalCase") });

    const { rule, skippedRules } = buildNamingConvention(profile);

    expect(rule).toEqual(["@typescript-eslint/naming-convention", ["error", { selector: "typeLike", format: ["PascalCase"] }]]);
    expect(skippedRules).toEqual([{
      tool: "eslint",
      rule: "@typescript-eslint/naming-convention",
      plugin: "@typescript-eslint",
      reason: expect.stringContaining('naming.variables convention "kebab-case"'),
    }]);
  });

  it("skips a non-string naming value instead of emitting it", () => {
    const { rule, skippedRules } = buildNamingConvention(makeProfile({ functions: naming(["camelCase"]) }));

    expect(rule).toBeNull();
    expect(skippedRules).toHaveLength(1);
  });

  it("takes severity only from naming values that produced a selector", () => {
    const profile = makeProfile({ constants: naming("kebab-case", 0.95), types: naming("PascalCase", 0.7) });

    const { rule } = buildNamingConvention(profile);

    expect(rule).toEqual(["@typescript-eslint/naming-convention", ["warn", { selector: "typeLike", format: ["PascalCase"] }]]);
  });

  it("passes eslint extension options through unmapped", () => {
    const options = [{ selector: "variable", format: ["camelCase", "UPPER_CASE"] }];
    const rule: StyleRule = { ...naming("anything"), extensions: { eslint: { options } } };

    const result = buildNamingConvention(makeProfile({ variables: rule }));

    expect(result.rule).toEqual(["@typescript-eslint/naming-convention", ["error", ...options]]);
    expect(result.skippedRules).toEqual([]);
  });
});

describe("buildNamingConvention under real ESLint", () => {
  it("loads every mapped profile value and reports violations instead of rejecting the config", async () => {
    const profile = makeProfile({
      constants: naming("UPPER_SNAKE_CASE"),
      types: naming("PascalCase"),
      functions: naming("SCREAMING_SNAKE"),
      variables: naming("kebab-case"),
    });
    const { rule } = buildNamingConvention(profile);

    const result = await lintWithRule(rule!, "export const MAX_SIZE = 1;\ntype bad_type = number;\n");

    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages.map((m) => m.ruleId)).toEqual(["@typescript-eslint/naming-convention"]);
    expect(result.messages[0]!.message).toContain("bad_type");
  });
});
