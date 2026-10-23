export {
  DOCTRINE_ENFORCEMENTS,
  DOCTRINE_STAGES,
  DoctrineRuleSchema,
  DOCTRINE_GRADES,
  DOCTRINE_LAYERS,
  PROMPT_ENFORCEMENTS,
  DOCTRINE_SOURCES,
  DoctrineVocabularySchema,
  type DoctrineEnforcement,
  type DoctrineLayer,
  type DoctrineRegistry,
  type DoctrineRule,
  type DoctrineStage,
  type DoctrineGrade,
  type DoctrineSource,
  type DoctrineVocabulary,
} from "./doctrine-schema.js";
export { DEFAULT_DOCTRINE_DIR, loadDoctrine, parseEvidenceTsv } from "./doctrine-load.js";
export { DOCTRINE_ISSUE_CODES, checkDoctrine, isCodeEnforced, type DoctrineIssue, type DoctrineIssueCode } from "./doctrine-checks.js";
export { findPromptLeaks, sliceForStage, type PromptLeak, type StageRequest, type StageSlice } from "./doctrine-slice.js";
export {
  AudiencePackSchema,
  PROFILE_FAMILIES,
  SERIES_FIELDS,
  TypeProfileSchema,
  type AudiencePack,
  type ProfileBlock,
  type ProfileFamily,
  type SeriesField,
  type TypeProfile,
} from "./profile-schema.js";
export {
  EXPLAIN_REPO_DEFAULT_TYPE,
  UnknownProfileError,
  UnknownStructureError,
  loadProfiles,
  loadStructures,
  profileFor,
  structureFor,
  type ProfileSet,
} from "./profile-load.js";
export { NarrativeStructureSchema, fits, renderSpine, type FitInput, type NarrativeStructure, type StructureFit } from "./structure-schema.js";
export { STRUCTURE_ISSUE_CODES, checkStructures, type StructureIssue, type StructureIssueCode } from "./structure-checks.js";
export { PAPER_PUBLISH_CHECKS, PROFILE_ISSUE_CODES, SERIES_BASE, checkProfiles, type ProfileIssue, type ProfileIssueCode } from "./profile-checks.js";
export { chapterOrder, type ChapterOrder, type MaterialSignals } from "./profile-order.js";
export { guideForType, writeTypeGuides, type TypeGuideDeps } from "./guide-type.js";
export {
  EvidenceSpanSchema,
  ExplainerFactSchema,
  FACT_KINDS,
  FACT_SOURCES,
  FactKindSchema,
  FactSourceSchema,
  GATHER_CODES,
  ReviewBundleSchema,
  VERIFIED_LEVELS,
  diag,
  gatherReview,
  parseCites,
  type EvidenceSpan,
  type ExplainerFact,
  type FactKind,
  type FactSource,
  type GatherCode,
  type GatherDiagnostic,
  type GatherOptions,
  type GatherProfile,
  type GatherResult,
  type ReviewBundle,
} from "./presets/repo-explainer/index.js";
