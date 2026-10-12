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
export { createTrialHost } from "./trial/host.js";
export type { TrialHost, TrialHostOptions, TrialStartInput, TrialTopology } from "./trial/host.js";
export type { TrialAttempt, TrialCall, TrialCost, TrialOutcome, TrialRunRecord } from "./trial/record.js";
export type { CodeStep, LaunchRequest, TrialLaunch } from "./trial/routes.js";
export { agentRoute } from "./trial/agent-route.js";
export type { AgentLaunch, AgentRouteOptions, TrialSandbox } from "./trial/agent-route.js";
export { runTrials, trialDirs, trialId } from "./trial/run.js";
export type { RunTrialsOptions, TrialDirs, TrialVariant } from "./trial/run.js";
export { scoreMeasurementAudit } from "./measurement-audit.js";
export type { AuditGold, AuditRun, AuditScore, GoldGap, GoldMetric } from "./measurement-audit.js";
export {
  LABEL_MATURITY_DAYS,
  buildCorpus,
  citedPaths,
  citesPath,
  deriveLabel,
  extractCorpus,
  gitClone,
  labelHistogram,
  openFactoryDb,
  readFactoryFacts,
  readOnlyUri,
  transcriptCost,
} from "./corpus/index.js";
export type {
  CorpusLabel,
  CorpusOptions,
  CorpusRow,
  CostOf,
  ExtractDeps,
  FactoryFacts,
  FactoryReader,
  FactoryRegistration,
  FactoryRun,
  GitPort,
  HeadVerdict,
  LabelInput,
  Landing,
  MainCommit,
  OwnerDecision,
  OwnerGateRow,
  RawLabels,
  ReviewCost,
  TranscriptRef,
} from "./corpus/index.js";
