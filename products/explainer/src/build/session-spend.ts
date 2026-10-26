import { priceRequest } from "@titan-design/agent-protocol/pricing";
import { findClaudeSessionSource, summarizeSession, type SessionUsageSummary } from "@titan-design/session-read";
import type { StageUsage } from "../workflow/records.js";

export interface SessionRef {
  sessionId: string;
  /** The session's working directory, which names its transcript's project directory. */
  cwd: string;
  /** The agent-chat account; it only namespaces the conversation's identity. */
  account?: string | null;
}

/** One agent run whose spend could not be read. */
export const UNKNOWN_SPEND: StageUsage = { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, costUnknown: true };

// session-read's input count already holds the cache reads and writes, which the price table charges apart.
function tokensOf({ tokens }: SessionUsageSummary) {
  const cacheReadTokens = tokens.cachedInput ?? 0;
  const cacheCreationTokens = tokens.cacheWriteInput ?? 0;
  return { inputTokens: Math.max((tokens.input ?? 0) - cacheReadTokens - cacheCreationTokens, 0), outputTokens: tokens.output ?? 0, cacheReadTokens, cacheCreationTokens };
}

/** Prices a session's own requests at the price table; a model the table lacks, or an unreported count, marks the spend unknown. */
export function priceSummaries(usage: readonly SessionUsageSummary[], at: Date): StageUsage {
  if (usage.length === 0) return UNKNOWN_SPEND;
  const unreported = usage.some(({ tokens }) => tokens.input === null || tokens.output === null);
  const counted = usage.map(tokensOf);
  const priced = usage.map((summary, i) => priceRequest(counted[i]!, summary.model ?? "", at.toISOString()));
  const sum = (pick: (tokens: (typeof counted)[number]) => number) => counted.reduce((total, tokens) => total + pick(tokens), 0);
  return {
    usd: priced.reduce((total, price) => total + price.costUsd, 0),
    inputTokens: sum((t) => t.inputTokens), outputTokens: sum((t) => t.outputTokens),
    cacheReadTokens: sum((t) => t.cacheReadTokens), cacheWriteTokens: sum((t) => t.cacheCreationTokens),
    calls: 1, ...(unreported || priced.some((price) => !price.priced) ? { costUnknown: true as const } : {}),
  };
}

/**
 * An agent's spend, read from its own transcript by session id once it has exited, so the budget sees a known cost at
 * once. A session with no transcript on this host is marked unknown rather than free.
 */
export async function sessionSpend(session: SessionRef, options: { configDir?: string; at: Date }): Promise<StageUsage> {
  if (session.sessionId === "") return UNKNOWN_SPEND;
  const lookup = findClaudeSessionSource({
    cwd: session.cwd, ...(options.configDir ? { configDir: options.configDir } : {}),
    conversation: { harness: "claude-code", namespace: session.account || "default", nativeId: session.sessionId },
  });
  if (lookup.status !== "found") return UNKNOWN_SPEND;
  const { usage } = await summarizeSession(lookup.source);
  return priceSummaries(usage, options.at);
}
