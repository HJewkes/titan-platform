import type { AwaitVerdictInput, ReviewerAgent, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";

/** A `ReviewerReader` whose seat read can take the roster its caller already holds, so a check reads the roster once. */
export type SeatReader = Omit<ReviewerReader, "readSeat"> & {
  readSeat?: (input: AwaitVerdictInput, roster?: readonly ReviewerAgent[]) => Promise<readonly ReviewerMessage[]>;
};
