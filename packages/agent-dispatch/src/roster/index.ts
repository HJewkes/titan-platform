export { foldAgent, stoppedAt } from './fold.js'
export { AgentLog, groupByAgent, launchedByBroker } from './log.js'
export { ROSTER_STATUSES, pairPresence } from './presence.js'
export type { PresenceInput, RosterEntry, RosterStatus } from './presence.js'
export { callerName, filterRoster, newestByName, viewRoster } from './filter.js'
export type { RosterFilter } from './filter.js'
export { predecessorFacts, predecessorSection, resolvePredecessor } from './predecessor.js'
export type { PredecessorFacts, PredecessorResult, PredecessorSource, TranscriptVerdict } from './predecessor.js'
export { inferWorkRole } from './work-role.js'
export { AGENT_LIFECYCLES, AGENT_ORIGINS, HUMAN, LAUNCHERS, launcherOf } from './types.js'
export type {
  AgentExit,
  AgentIdentity,
  AgentLifecycle,
  AgentOrigin,
  Launcher,
  QueueItem,
  RosterHidden,
  RosterView,
} from './types.js'
export {
  EXIT_TAIL_BYTES,
  NO_TOOL_CALL,
  UNKNOWN_ACTION,
  UNREPORTED_EXIT,
} from './exit-report.js'
export {
  actionPattern,
  exitTailOf,
  readExitTail,
  unreportedExitText,
} from './exit-report.js'
export type { ExitTail } from './exit-report.js'
export { crossingBriefPaths } from './brief-paths.js'
export {
  BACKGROUNDED_BRIEF,
  SURFACED_NOTICE,
  checkBackgroundable,
  checkSurfaceable,
  placementFor,
} from './mode-switch.js'
export type { SurfacePlacement, SwitchOutcome } from './mode-switch.js'
export {
  RESUMED_BRIEF,
  describeResume,
  identityBlocker,
  missingAgent,
  resumeBlocker,
  verdictLine,
} from './resume-session.js'
export type { ReattachTree } from './resume-session.js'
export {
  WORK_ROLES,
  WORK_ROLE_CHOICES,
  assignmentMeta,
  assignmentRefusal,
  githubRepoOf,
  isExperimentArm,
  isWorkRole,
  spawnProvenance,
  successorProvenance,
  worktreeProvenance,
} from './provenance.js'
export type {
  AssignmentRequest,
  ExperimentArm,
  GitRunner,
  ProvenanceAllocation,
  WorkRole,
} from './provenance.js'
