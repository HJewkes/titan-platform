import type { Profile } from "@titan-design/style-profile";
import {
  buildNamingConventionRule,
  buildImportOrderRule,
  buildFunctionLengthRule,
  buildFileNamingRule,
  buildJsdocRules,
} from "@titan-design/style-profile";

export interface EslintFlatConfigEntry {
  plugins?: Record<string, unknown>;
  rules?: Record<string, unknown>;
  files?: string[];
}

// ESLint accepts only off, warn and error; style-profile's "info" tier becomes warn, as its own exporter does.
function withEslintSeverity(value: unknown): unknown {
  if (Array.isArray(value) && value[0] === "info") return ["warn", ...value.slice(1)];
  return value === "info" ? "warn" : value;
}

function collectRules(profile: Profile): Record<string, unknown> {
  const rules: Record<string, unknown> = {};

  const namingRule = buildNamingConventionRule(profile);
  if (namingRule) rules[namingRule[0]] = namingRule[1];

  const importRule = buildImportOrderRule(profile);
  if (importRule) rules[importRule[0]] = importRule[1];

  const fnLengthRule = buildFunctionLengthRule(profile);
  if (fnLengthRule) rules[fnLengthRule[0]] = fnLengthRule[1];

  const fileNamingRule = buildFileNamingRule(profile);
  if (fileNamingRule) rules[fileNamingRule[0]] = fileNamingRule[1];

  const jsdocRules = buildJsdocRules(profile);
  for (const [name, value] of jsdocRules) {
    rules[name] = value;
  }

  for (const name of Object.keys(rules)) rules[name] = withEslintSeverity(rules[name]);
  return rules;
}

export function generateEslintConfig(profile: Profile): EslintFlatConfigEntry[] {
  const entries: EslintFlatConfigEntry[] = [];
  const rules = collectRules(profile);

  if (Object.keys(rules).length > 0) {
    entries.push({
      files: ["**/*.ts", "**/*.tsx"],
      rules,
    });
  }

  return entries;
}
