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
