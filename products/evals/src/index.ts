export {
  CheckSpecSchema,
  EvalCaseSchema,
  SPEC_SCHEMA_VERSIONS,
  ScorecardSchema,
  SuiteSpecSchema,
  UnitSpecSchema,
  TrialRecordSchema,
  VariantSpecSchema,
  parseSpec,
  parseTrialRecord,
} from "./spec/index.js";
export type { CheckSpec, EvalCase, Scorecard, Spec, SpecSchemaVersion, StepSpec, SuiteSpec, TrialRecord, UnitSpec, VariantSpec } from "./spec/index.js";
export { MODEL_ID_PATTERN, SHA256_PATTERN, SPEC_ID_PATTERN } from "./spec/common.js";
export type { SpecParseMode } from "./spec/common.js";
export { CHECK_ROLES, DETERMINISTIC_CHECK_TYPES, EFFICIENCY_METRICS } from "./spec/check.js";
export { CASE_SPLITS } from "./spec/case-suite.js";
export { EFFORT_LEVELS } from "./spec/variant.js";
export {
  canonicalJson,
  caseHash,
  hashCanonical,
  HASH_EXCLUDED_FIELDS,
  judgesHash,
  pinSuitePrompts,
  pinVariantPrompts,
  scorecardKeyHash,
  sha256Hex,
  suiteHash,
  unitHash,
  variantHash,
} from "./hash.js";
export type { ReadPrompt } from "./hash.js";
export { hashSpec, validateSpec } from "./validate.js";
export type { SpecValidation } from "./validate.js";
export { scorecardKeysFor, startTrial } from "./trial.js";
export type { ChampionOf, TrialStart, UnitRef } from "./trial.js";
