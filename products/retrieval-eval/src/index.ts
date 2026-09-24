export type { Arm, EvalPair, Label, LabelScope, LinkMethod, Provenance } from "./pairs.js";
export { formatPairs, labelKeys, LABEL_SCOPES, parsePairs, scopePair } from "./pairs.js";
export type { ToolUse, TranscriptHead } from "./corpus/transcripts.js";
export {
  defaultTranscriptRoots,
  discoverTranscripts,
  readHead,
  streamToolUses,
  textOf,
  transcriptId,
} from "./corpus/transcripts.js";
export { dedupeLabels, defaultActiveRoot, labelledPathOf, normaliseLabel } from "./mine/labels.js";
export { listOfMaps, readFrontmatter, scalarField } from "./mine/frontmatter.js";
export type { Link, Spawn, SpawnMining } from "./mine/spawn-arm.js";
export { briefingSlug, briefProbe, collectSpawns, linkSpawn, mineSpawnArm } from "./mine/spawn-arm.js";
export type { BootstrapMining, SessionRecord } from "./mine/bootstrap-arm.js";
export {
  indexHeads,
  loopQuery,
  mineBootstrapArm,
  readSessionRecord,
  resolveTranscript,
  sessionDirs,
} from "./mine/bootstrap-arm.js";
export type { QueryVariant } from "./query/variants.js";
export { deriveQuery, documentFrequency, headingAndLead, QUERY_VARIANTS, terms, topTermsByDf } from "./query/variants.js";
export type { Candidate, SearchContext } from "./candidates/candidate.js";
export { defaultGraphPath, noteAliases } from "./candidates/candidate.js";
export { activeWorkSearch, hitsOf } from "./candidates/active-work-search.js";
export type { DateOrderOptions } from "./candidates/date-order.js";
export { dateOrderNotes, INJECTED_TODAY, newestNotes } from "./candidates/date-order.js";
export { matchExpression, notesFts, openReadOnly } from "./candidates/notes-fts.js";
export type { NoteDocument } from "./candidates/hybrid-vector.js";
export { buildIndex, hybridVector, loadNotes } from "./candidates/hybrid-vector.js";
export type { AggregateScore, PairScore, ScoredHit } from "./metrics.js";
export { aggregate, matchRanks, scorePair } from "./metrics.js";
export type { RunOptions, RunRow } from "./run.js";
export { BUDGET_K, DEFAULT_KS, formatRows, runEval } from "./run.js";
export type { CorpusSnapshot } from "./snapshot.js";
export { activeWorkVersion, snapshot } from "./snapshot.js";
export type { UptakeOptions, UptakeReport, UsageClass } from "./uptake.js";
export { classify, countUptake } from "./uptake.js";
export type { RefClass, ServedRef, Trigger } from "./served/blocks.js";
export { parseBootstrapBlock, parseSpawnBlock } from "./served/blocks.js";
export type { ServedBlock, ServedSession, Window } from "./served/session.js";
export { readServedSession } from "./served/session.js";
export type { BaseRateCount, RefLabels } from "./served/labels.js";
export {
  indexWrapRecords,
  isCited,
  isOpened,
  OPENED_SECTION_UNAVAILABLE,
  unservedBaseRate,
  wrapRecordFor,
} from "./served/labels.js";
export type { ClassRow, FileRow, InitiativeRow, Observation, ServedInputs, ServedReport, Tally } from "./served/report.js";
export { buildReport, collectServed } from "./served/report.js";
export { formatServed } from "./served/format.js";
