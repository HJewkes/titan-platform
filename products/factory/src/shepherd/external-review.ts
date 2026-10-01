import { parseVerdictBlock } from "@titan-design/session-read";
import { deadline } from "../workflows/deadline.js";
import type { AwaitVerdictResult, AwaitVerdictTiming, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import type { Registration } from "./store.js";

/** A bd-reviewer's peer name as coordinators spell it: `<anything>-review`, optionally `-r<N>` for a later round. */
const REVIEWER_NAME = /\b[a-z0-9][a-z0-9-]*-review(?:-r\d+)?\b/;

/** The reviewer a hold waits on: one named in its reason, else the registration's reviewer; undefined when the run is not held for one. */
export function externalReviewer(registration: Registration | undefined): string | undefined {
  if (!registration?.held) return undefined;
  return registration.holdReason?.match(REVIEWER_NAME)?.[0] ?? registration.reviewer ?? undefined;
}

export interface ExternalVerdictInput {
  repo: string;
  pr: number;
  head: string;
  external: string;
}

export function isExternalVerdictInput(raw: unknown): raw is ExternalVerdictInput {
  return typeof raw === "object" && raw !== null && typeof (raw as { external?: unknown }).external === "string";
}

/** The newest message of the reviewer's latest session whose verdict block names this PR at this head. */
export function acceptExternalVerdict(input: ExternalVerdictInput, row: ReviewerAgent, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const own = messages.filter((message) => message.agentId === row.agentId && message.sessionId === row.sessionId);
  for (const message of [...own].sort((a, b) => b.writtenAt - a.writtenAt)) {
    const block = parseVerdictBlock(message.text);
    if (!block.ok || block.repo !== input.repo || block.pr !== input.pr || block.head !== input.head) continue;
    const accepted = { kind: "verdict" as const, head: block.head, locator: message.locator, reviewer: { agentId: row.agentId, sessionId: row.sessionId } };
    return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE" } : { ...accepted, verdict: "FIX_FIRST", text: message.text };
  }
  return { kind: "none" };
}

/** A name can span sessions; the last row the roster lists with a session holds it. */
function latestSession(name: string, roster: readonly ReviewerAgent[]): ReviewerAgent | undefined {
  return roster.filter((agent) => agent.name === name && agent.sessionId !== "").at(-1);
}

/** Polls the hold's reviewer for a verdict at this head; Shepherd starts nobody, and the deadline ends the wait with `none`. */
export async function awaitExternalVerdict(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, input: ExternalVerdictInput, timing: AwaitVerdictTiming, signal: AbortSignal): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const row = latestSession(input.external, await roster().catch(() => []));
    if (row) {
      const read = { repo: input.repo, pr: input.pr, head: input.head, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
      const result = acceptExternalVerdict(input, row, await reader.read(read).catch(() => []));
      if (result.kind === "verdict") return result;
    }
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}
