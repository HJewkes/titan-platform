import type { SourceTextLocator } from "@titan-design/session-read";

/** The pull request head a reviewer is asked about. */
export interface ReviewTarget {
  /** `owner/repo`. */
  repo: string;
  pr: number;
  /** 40 lowercase hex characters. */
  head: string;
}

/**
 * Whether a session holds an agent's name. `agent ls --json` reports `live`, `detached` and `exited`; `exiting` is the
 * short stretch while a session closes, `deregistered` is the broker's word for a name with no row at all, and `unknown`
 * is any other value the roster reports.
 */
export type Presence = "live" | "detached" | "exiting" | "exited" | "deregistered" | "unknown";

/** The signals a dispatch reads to pick a reviewer's profile. */
export interface ReviewerFacts {
  /** The run's registered kind. */
  kind?: string;
  /** The kind could not be read, so the PR takes the stricter class. */
  unread?: boolean;
  /** Additions plus deletions; absent means unknown. Nothing populates it until the github port reports line counts (TP-1755). */
  changedLines?: number;
}

/** One roster row, as the dispatch port reports it. */
export interface ReviewerAgent {
  name: string;
  agentId: string;
  /** Empty until the agent's session has started. */
  sessionId: string;
  presence: Presence;
  spawnedBy: string | null;
  /** The agent this one took over from, null for none; absent means the port holds no lineage, and such an agent is never resumed. */
  predecessor?: string | null;
  /** Context tokens the session holds; absent means unknown, and an unknown fill is never resumed. */
  fillTokens?: number;
  /** Epoch milliseconds of the latest write to the session's transcript, which a resume appends to; absent means unknown. */
  lastWrittenAt?: number;
}

/** How a caller starts a reviewer; a throw from `spawn` or `resume` that the caller does not classify as a broker outage is a refusal. */
export interface ReviewerDispatch {
  roster(): Promise<readonly ReviewerAgent[]>;
  /** `target` names the repo whose checkout the reviewer starts in; `facts` pick the reviewer's profile. */
  spawn(name: string, brief: string, target: ReviewTarget, facts?: ReviewerFacts): Promise<void>;
  resume(name: string, brief: string): Promise<void>;
}

/** The dispatched reviewer whose verdict a caller waits for. */
export interface AwaitVerdictInput extends ReviewTarget {
  reviewerAgentId: string;
  reviewerSessionId: string;
  /** Epoch milliseconds. */
  dispatchedAt: number;
  /** Epoch milliseconds when the reviewer's session was up; the wait counts from it. Absent on a run recorded before it existed. */
  startedAt?: number;
}

/** One assistant message, attributed by the reader to the agent and session it came from. */
export interface ReviewerMessage {
  agentId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  writtenAt: number;
  text: string;
  locator: SourceTextLocator;
  /** Investigative tool calls the session made before this message; absent means the reader could not count, and no floor applies. */
  investigativeCalls?: number;
  /**
   * Set only for a record the client wrote in the model's place (Claude Code's `<synthetic>` model), from the record's own
   * fields and never from its text: the API error it names, and the quota reset in epoch milliseconds. Absent means a model wrote it.
   */
  synthetic?: { apiError: string | null; resetsAt: number | null };
}

/** The assistant messages of the dispatched reviewer's session, oldest first; the last one is the final message. */
export interface ReviewerReader {
  read(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
  /** A seat reviewer's sent messages from every complete record, finished turn or not; rejects on a damaged transcript. Absent means `read`. */
  readSeat?(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
}
