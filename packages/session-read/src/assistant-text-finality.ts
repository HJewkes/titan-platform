import type { NormalizedSessionObservation } from "./normalized.js";

interface Position { line: number; part: number }

function contentIndex(path: readonly (string | number)[]): number {
  return path[0] === "message" && path[1] === "content" && typeof path[2] === "number" ? path[2] : -1;
}

function after(left: Position, right: Position): boolean {
  return left.line > right.line || (left.line === right.line && left.part > right.part);
}

/**
 * Projects source-order assistant-text finality, without interpreting verdicts.
 * This is not session/process completion, reviewer approval, or provider authority.
 * One instance consumes one source; copied history never supplies final text.
 */
export function assistantTextFinality() {
  let text: Position | undefined;
  let continuation: Position | undefined;
  return {
    add(observation: NormalizedSessionObservation): void {
      const claude = observation.conversation.harness === "claude-code";
      const line = observation.evidence.line.byteOffset;
      if (observation.kind === "message" && observation.role === "assistant" &&
          observation.historyOrigin === null && observation.content.length > 0) {
        const last = observation.content.at(-1);
        if (last === undefined) return;
        const position = { line, part: claude ? contentIndex(last.locator.selector.path) : -1 };
        if (text === undefined || after(position, text)) text = position;
        return;
      }
      // Preserve the existing Claude reader's native bookkeeping exceptions.
      // Codex unknown envelopes are never presumed bookkeeping.
      const bookkeeping = claude
        ? (observation.kind === "metadata" && !observation.entries.some(entry => entry.name === "model")) ||
          (observation.kind === "unknown" && !observation.nativeKind.startsWith("claude.content.") &&
            !observation.nativeKind.startsWith("claude.message."))
        : observation.kind === "metadata" || observation.kind === "usage" ||
          (observation.kind === "native_turn" && observation.phase === "completed");
      if (bookkeeping) return;
      const position = { line, part: claude ? contentIndex(observation.evidence.subrecord.path) : -1 };
      if (continuation === undefined || after(position, continuation)) continuation = position;
    },
    hasFinalText: (): boolean => text !== undefined && (continuation === undefined || !after(continuation, text)),
  };
}
