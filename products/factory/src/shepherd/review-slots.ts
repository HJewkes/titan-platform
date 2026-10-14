/** One roster reading of the reviewers running: their names, or why the roster could not be read. */
export type ReviewerReading = { running: readonly string[] } | { rosterError: string };

/** The last reading beside the concurrent cap, for `shepherd status`; a failed read has no `running`, so it never stands in for 0. */
export interface ReviewSlots {
  running?: string[];
  cap: number;
  readAt: string;
  rosterError?: string;
}
