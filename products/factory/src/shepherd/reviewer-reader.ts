import os from "node:os";
import { claudeSourceFromPath, readSessionObservations, type NormalizedSessionObservation } from "@titan-design/session-read";
import type { AwaitVerdictInput, ReviewerMessage, ReviewerReader } from "./review.js";

/** The roster fields the reader needs; an `agent ls --json` row carries all of them. */
export interface TranscriptRow {
  agentId: string;
  sessionId: string;
  presence: string;
  transcriptPath: string | null;
  transcriptExists: boolean;
}

export interface TranscriptReviewerReaderOptions {
  roster: () => Promise<readonly TranscriptRow[]>;
  /** Names the machine in every locator; defaults to the hostname, as session-miner does. */
  namespace?: string;
}

/** Only `exited` is a finished session; a `detached` process may still be writing its turn. */
const FINISHED = "exited";

/** One message per assistant text part written in this conversation; user messages and copied history yield none. */
export function reviewerMessages(agentId: string, observation: NormalizedSessionObservation): ReviewerMessage[] {
  if (observation.kind !== "message" || observation.role !== "assistant" || observation.historyOrigin !== null) return [];
  const writtenAt = observation.timestamp === null ? Number.NaN : Date.parse(observation.timestamp);
  const sessionId = observation.conversation.nativeId;
  return observation.content.map((part) => ({ agentId, sessionId, writtenAt, text: part.text, locator: part.locator }));
}

/** The finished transcript of the dispatched agent and session, or null while there is nothing safe to read. */
function finishedTranscript(rows: readonly TranscriptRow[], input: AwaitVerdictInput): (TranscriptRow & { transcriptPath: string }) | null {
  const row = rows.find((candidate) => candidate.agentId === input.reviewerAgentId);
  if (!row || row.presence !== FINISHED || row.sessionId !== input.reviewerSessionId) return null;
  if (!row.transcriptExists || row.transcriptPath === null) return null;
  return { ...row, transcriptPath: row.transcriptPath };
}

/** Reads the dispatched reviewer's own finished transcript; a read error propagates, and the caller treats it as nothing yet. */
export function transcriptReviewerReader(options: TranscriptReviewerReaderOptions): ReviewerReader {
  const namespace = options.namespace ?? os.hostname();
  return {
    async read(input) {
      const row = finishedTranscript(await options.roster(), input);
      if (!row) return [];
      const messages: ReviewerMessage[] = [];
      for await (const observation of readSessionObservations(claudeSourceFromPath(row.transcriptPath, namespace))) {
        messages.push(...reviewerMessages(row.agentId, observation));
      }
      return messages;
    },
  };
}
