import type { AgentRow } from "@titan-design/agent-dispatch";
import { priceRequest } from "@titan-design/session-analytics";
import { extractTranscript } from "@titan-design/session-read";
import type { StepUsage } from "@titan-design/workflow";
import { distinctRequests, type TranscriptRequest } from "./autoresearch/agent-run.js";

/** An agent's turn ran but its spend cannot be read: nothing is known but that a budget may not call it free. */
export const UNMETERED: StepUsage = { costUsd: 0, costUnknown: true };

/** What `row`'s agent has spent since `sinceMs`; undefined while its transcript reports no usage at all. */
export type StepMeter = (row: AgentRow, sinceMs: number) => Promise<StepUsage | undefined>;

const contextOf = (request: TranscriptRequest): number => request.inputTokens + request.cacheReadTokens + request.cacheCreationTokens;

/** A fix round resumes the same session, so its transcript holds every earlier round: only requests from `sinceMs` on are this step's. */
function usageSince(requests: readonly TranscriptRequest[], sinceMs: number): StepUsage {
  const turn = distinctRequests(requests).filter((request) => Date.parse(request.ts) >= sinceMs);
  const priced = turn.map((request) => priceRequest(request, request.model, request.ts));
  const models = new Set(turn.map((request) => request.model));
  const [model] = models;
  return {
    costUsd: priced.reduce((sum, request) => sum + request.costUsd, 0),
    outputTokens: turn.reduce((sum, request) => sum + request.outputTokens, 0),
    ...(models.size === 1 && model ? { model } : {}),
    ...(turn.length > 0 ? { peakContextTokens: Math.max(...turn.map(contextOf)) } : {}),
    ...(priced.some((request) => !request.priced) ? { costUnknown: true as const } : {}),
  };
}

/** Reads and prices the transcript the roster row names, whole on each call: the polls are slow and a step's requests are few. */
export const transcriptMeter: StepMeter = async (row, sinceMs) => {
  if (row.transcriptExists !== true || !row.transcriptPath) return undefined;
  const { requests } = await extractTranscript(row.transcriptPath);
  return requests.length === 0 ? undefined : usageSince(requests, sinceMs);
};
