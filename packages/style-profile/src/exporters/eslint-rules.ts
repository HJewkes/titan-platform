import type { Profile, SeverityThresholds, Severity } from "../schema/profile.js";
import type { StyleRule } from "../schema/style-rule.js";

export function toEslintSeverity(
  confidence: number,
  thresholds: SeverityThresholds,
): Severity | null {
  if (confidence >= thresholds.error) return "error";
  if (confidence >= thresholds.warn) return "warn";
  if (confidence >= thresholds.info) return "info";
  return null;
}

export function severityRank(s: Severity): number {
  return s === "error" ? 3 : s === "warn" ? 2 : 1;
}

// Key order is significant: typescript-eslint's last-matching-selector-wins rule needs "variables" before "constants".
const NAMING_SELECTORS: Record<string, string> = {
  variables: "variable",
  functions: "function",
  types: "typeLike",
  constants: "variable",
};

// Scopes "constants" to top-level const declarations, so it doesn't shadow the "variables" rule for every const.
const NAMING_MODIFIERS: Partial<Record<string, string[]>> = {
  constants: ["const", "global"],
};

function eslintExtensionOptions(rule: StyleRule): unknown[] | undefined {
  const eslintExt = rule.extensions?.eslint;
  return eslintExt &&
    typeof eslintExt === "object" &&
    "options" in eslintExt &&
    Array.isArray((eslintExt as Record<string, unknown>).options)
    ? ((eslintExt as Record<string, unknown>).options as unknown[])
    : undefined;
}

const NAMING_RULE = "@typescript-eslint/naming-convention";

// Keys are profile vocabulary (style-analyzer emits SCREAMING_SNAKE); values are typescript-eslint's format enum.
const TS_ESLINT_FORMATS: Record<string, string> = {
  camelCase: "camelCase",
  strictCamelCase: "strictCamelCase",
  PascalCase: "PascalCase",
  StrictPascalCase: "StrictPascalCase",
  snake_case: "snake_case",
  UPPER_CASE: "UPPER_CASE",
  UPPER_SNAKE_CASE: "UPPER_CASE",
  SCREAMING_SNAKE: "UPPER_CASE",
  SCREAMING_SNAKE_CASE: "UPPER_CASE",
};

/** Same shape as style-checker's SkippedRule, so a consumer can forward it unchanged. */
export interface EslintSkippedRule {
  tool: "eslint";
  rule: string;
  plugin: string;
  reason: string;
}

export interface NamingConventionResult {
  rule: [string, unknown] | null;
  skippedRules: EslintSkippedRule[];
}

export function toTsEslintFormat(convention: string): string | null {
  return TS_ESLINT_FORMATS[convention] ?? null;
}

function skippedNaming(key: string, convention: unknown): EslintSkippedRule {
  return {
    tool: "eslint",
    rule: NAMING_RULE,
    plugin: "@typescript-eslint",
    reason: `naming.${key} convention ${JSON.stringify(convention)} has no typescript-eslint naming-convention format`,
  };
}

function namingSelectors(
  key: string,
  rule: StyleRule,
  selectorName: string,
  skipped: EslintSkippedRule[],
): unknown[] {
  const eslintOptions = eslintExtensionOptions(rule);
  if (eslintOptions) return eslintOptions;
  const format = typeof rule.convention === "string" ? toTsEslintFormat(rule.convention) : null;
  if (!format) {
    skipped.push(skippedNaming(key, rule.convention));
    return [];
  }
  const modifiers = NAMING_MODIFIERS[key];
  return [{ selector: selectorName, format: [format], ...(modifiers ? { modifiers } : {}) }];
}

export function buildNamingConvention(profile: Profile): NamingConventionResult {
  const thresholds = profile.severityThresholds;
  const selectors: unknown[] = [];
  const skippedRules: EslintSkippedRule[] = [];
  let maxSeverity: Severity | null = null;

  for (const key of Object.keys(NAMING_SELECTORS)) {
    const rule = profile.naming?.[key];
    if (!rule) continue;
    const selectorName = NAMING_SELECTORS[key]!;
    const severity = toEslintSeverity(rule.confidence, thresholds);
    if (!severity) continue;

    const ruleSelectors = namingSelectors(key, rule, selectorName, skippedRules);
    if (ruleSelectors.length === 0) continue;
    selectors.push(...ruleSelectors);
    if (!maxSeverity || severityRank(severity) > severityRank(maxSeverity)) maxSeverity = severity;
  }

  if (selectors.length === 0 || !maxSeverity) return { rule: null, skippedRules };
  return { rule: [NAMING_RULE, [maxSeverity, ...selectors]], skippedRules };
}

export function buildNamingConventionRule(
  profile: Profile,
): [string, unknown] | null {
  return buildNamingConvention(profile).rule;
}

export function buildImportOrderRule(
  profile: Profile,
): [string, unknown] | null {
  const importOrder = profile.structure?.importOrder;
  if (!importOrder) return null;
  const severity = toEslintSeverity(importOrder.confidence, profile.severityThresholds);
  if (!severity) return null;

  const convention = Array.isArray(importOrder.convention)
    ? importOrder.convention
    : ["builtin", "external", "internal", "relative"];

  return [
    "perfectionist/sort-imports",
    [
      severity,
      {
        type: "natural",
        groups: convention,
      },
    ],
  ];
}

export function buildFunctionLengthRule(
  profile: Profile,
): [string, unknown] | null {
  const maxLines = profile.structure?.functionMaxLines;
  if (!maxLines) return null;
  const severity = toEslintSeverity(maxLines.confidence, profile.severityThresholds);
  if (!severity) return null;
  if (typeof maxLines.convention !== "number") return null;

  return ["max-lines-per-function", [severity, { max: maxLines.convention }]];
}

export function buildFileNamingRule(
  profile: Profile,
): [string, unknown] | null {
  const files = profile.naming?.files;
  if (!files) return null;
  const severity = toEslintSeverity(files.confidence, profile.severityThresholds);
  if (!severity) return null;
  if (typeof files.convention !== "string") return null;

  const caseMap: Record<string, string> = {
    "kebab-case": "kebabCase",
    camelCase: "camelCase",
    PascalCase: "pascalCase",
    snake_case: "snakeCase",
  };

  return [
    "unicorn/filename-case",
    [severity, { case: { [caseMap[files.convention] ?? "kebabCase"]: true } }],
  ];
}

export function buildJsdocRules(
  profile: Profile,
): Array<[string, unknown]> {
  const rules: Array<[string, unknown]> = [];
  const docs = profile.documentation;
  if (!docs) return rules;

  const functionDocs = docs.functionDocs;
  if (!functionDocs) return rules;

  const severity = toEslintSeverity(functionDocs.confidence, profile.severityThresholds);
  if (!severity) return rules;

  if (functionDocs.convention === "jsdoc-selective") {
    rules.push(["jsdoc/require-jsdoc", [severity, { publicOnly: true }]]);
  } else if (functionDocs.convention === "jsdoc-all") {
    rules.push(["jsdoc/require-jsdoc", [severity]]);
  }

  return rules;
}
