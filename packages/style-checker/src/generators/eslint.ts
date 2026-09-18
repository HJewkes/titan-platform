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

export function generateEslintConfig(profile: Profile): EslintFlatConfigEntry[] {
  const entries: EslintFlatConfigEntry[] = [];
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

  if (Object.keys(rules).length > 0) {
    entries.push({
      files: ["**/*.ts", "**/*.tsx"],
      rules,
    });
  }

  return entries;
}
