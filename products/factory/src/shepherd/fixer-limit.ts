import type { AgentRow } from "@titan-design/agent-dispatch";
import { acceptVerdict, isUsageLimit, type AwaitVerdictInput } from "@titan-design/review-panel";
import { markLimit } from "./account-hold.js";
import { DEFAULT_ACCOUNT } from "./account-limit.js";
import type { ShepherdDeps } from "./phases.js";
import { transcriptReviewerReader, type TranscriptRow } from "./reviewer-reader.js";

/** The client's usage-limit notice that ended an exited agent's session, read with the predicate a review's reader uses. */
async function limitNotice(row: AgentRow, namespace?: string): Promise<{ notice: string; resetsAt?: number } | undefined> {
  if (row.transcriptPath == null || row.transcriptExists !== true) return undefined;
  const transcript: TranscriptRow = { agentId: row.agentId, sessionId: row.sessionId, presence: "exited", transcriptPath: row.transcriptPath, transcriptExists: true };
  const input: AwaitVerdictInput = { repo: "", pr: 0, head: "", reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
  const result = acceptVerdict(input, await transcriptReviewerReader({ roster: async () => [transcript], ...(namespace !== undefined && { namespace }) }).read(input));
  if (result.kind !== "none" || !isUsageLimit(result) || result.notice === undefined) return undefined;
  return { notice: result.notice, ...(result.resetsAt !== undefined && { resetsAt: result.resetsAt }) };
}

/**
 * A fixer or successor whose session ended on its account's usage limit marks that account exhausted, as a reviewer's does,
 * so the next successor spawns elsewhere. agent-chat's row names no account for its default one. A read that fails records nothing.
 */
export function noteFixerLimit(deps: Pick<ShepherdDeps, "accountLimits" | "now">, namespace?: string): (row: AgentRow) => Promise<void> {
  return async (row) => {
    try {
      const limit = await limitNotice(row, namespace);
      if (limit && deps.accountLimits) markLimit(deps.accountLimits.get(), { account: row.account ?? DEFAULT_ACCOUNT, ...limit }, deps.now());
    } catch (error) {
      console.warn(`shepherd: ${row.name}'s usage limit was not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
