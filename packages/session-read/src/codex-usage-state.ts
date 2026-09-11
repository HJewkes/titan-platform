import type { TokenCounts } from "@titan-design/agent-protocol";

/** Tracks snapshot resets and suppresses high-level totals already observed in raw usage. */
export class CodexUsageState {
  private readonly rawSignatures = new Set<string>();
  private epochIndex = 0;
  private lastConversationTotal: number | null = null;

  observeRawConversation(tokens: TokenCounts): void {
    this.observeConversation(tokens.total);
    this.rawSignatures.add(tokenSignature(tokens));
  }

  shouldUseProjection(tokens: TokenCounts): boolean {
    return !this.rawSignatures.has(tokenSignature(tokens));
  }

  observeConversation(total: number | null): void {
    if (total !== null && this.lastConversationTotal !== null && total < this.lastConversationTotal) this.advanceEpoch();
    this.lastConversationTotal = total;
  }

  compact(): void {
    this.advanceEpoch();
  }

  epoch(sourceId: string): string {
    return `${sourceId}:usage:${this.epochIndex}`;
  }

  private advanceEpoch(): void {
    this.epochIndex += 1;
    this.lastConversationTotal = null;
    this.rawSignatures.clear();
  }
}

function tokenSignature(tokens: TokenCounts): string {
  return [tokens.input, tokens.output, tokens.cachedInput, tokens.cacheWriteInput, tokens.reasoningOutput, tokens.total].join(":");
}
