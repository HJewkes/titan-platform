export type { ChurnWindow } from "./window.js";
export {
  entriesWithin,
  loadChurnEntries,
  parseChurnLog,
  resolveRenamedPath,
  type ChurnEntry,
  type LoadChurnOptions,
} from "./log.js";
export { loadFileFirstSeen, type FirstSeenOptions } from "./first-seen.js";
export { aggregateChurn, aggregateChurnWindows, type PathChurn } from "./churn.js";
export {
  authorLinesByPath,
  computeOwnership,
  summarizeOwnership,
  type ComputeOwnershipOptions,
  type OwnershipForFile,
} from "./ownership.js";
export {
  computeChangeCoupling,
  couplingFor,
  type ChangeCouplingResult,
  type CoEditPair,
  type ComputeChangeCouplingOptions,
  type CouplingPartner,
} from "./change-coupling.js";
