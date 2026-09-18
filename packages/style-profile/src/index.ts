export {
  StyleRuleSchema,
  ExampleSchema,
  StabilitySchema,
  FixabilitySchema,
  type StyleRule,
  type Stability,
  type Fixability,
} from "./schema/style-rule.js";
export {
  ProfileSchema,
  SCHEMA_VERSION,
  DEFAULT_SEVERITY_THRESHOLDS,
  PROFILE_CATEGORIES,
  type Profile,
  type ProfileCategory,
  type SeverityThresholds,
  type Severity,
} from "./schema/profile.js";

export { readProfile, writeProfile, validateProfile } from "./io.js";

export { migrateProfile, registerMigration } from "./migrations/migrate-profile.js";

export type { GeneratedFile } from "./exporters/types.js";
export { generateSkillFiles } from "./exporters/skill.js";
export { generateClaudeRules } from "./exporters/claude-rules.js";
export { generateHooksConfig } from "./exporters/hooks.js";
export { generateEslintExport } from "./exporters/eslint.js";
export {
  toEslintSeverity,
  severityRank,
  buildNamingConventionRule,
  buildImportOrderRule,
  buildFunctionLengthRule,
  buildFileNamingRule,
  buildJsdocRules,
} from "./exporters/eslint-rules.js";
export { generateRuffExport } from "./exporters/ruff.js";
export { generateMarkdownExport } from "./exporters/markdown.js";
export { generateEditorConfigExport } from "./exporters/editorconfig.js";
export {
  exportProfile,
  SUPPORTED_FORMATS,
  type ExportFormat,
} from "./exporters/export-index.js";
export {
  extractAllRules,
  getTopRules,
  getRulesByCategory,
  getRulesForCategory,
  detectLanguages,
  type RuleEntry,
  type ExtractedRule,
} from "./exporters/template-helpers.js";
