import { parseVerdictBlock, type SourceTextLocator } from "@titan-design/session-read";
import type { StepDeclaration } from "../definition.js";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepRoute } from "../routed-runner.js";
import { deadline } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, noFreezeStoreUntilTp523, type IsFrozen, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, ShepherdPhases, Verdict } from "./phases.js";

export const AWAIT_VERDICT_STEP = "sh-await-verdict";
export const REVIEW_STEPS: readonly StepDeclaration[] = [
  { id: AWAIT_VERDICT_STEP, kind: "dispatch" },
  { id: MERGE_EVIDENCE_STEP, kind: "dispatch" },
];

export const DEFAULT_VERDICT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 30_000;
const HEAD = /^[0-9a-f]{40}$/;

export interface AwaitVerdictInput {
  repo: string;
  pr: number;
  head: string;
  reviewerAgentId: string;
  reviewerSessionId: string;
  /** Epoch milliseconds. */
  dispatchedAt: number;
}

/** One assistant message, attributed by the reader to the agent and session it came from. */
export interface ReviewerMessage {
  agentId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  writtenAt: number;
  text: string;
  locator: SourceTextLocator;
}

/** The assistant messages of the dispatched reviewer's session, oldest first; the last one is the final message. */
export interface ReviewerReader {
  read(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
}

export type AwaitVerdictResult =
  | { kind: "verdict"; verdict: "MERGE" | "FIX_FIRST"; head: string; locator: SourceTextLocator }
  | { kind: "none" };

export interface AwaitVerdictTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}

export function parseAwaitVerdictInput(raw: unknown): AwaitVerdictInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value === "") throw new Error(`sh-await-verdict: ${name} must be a non-empty string`);
    return value;
  };
  const { pr, dispatchedAt } = input;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("sh-await-verdict: pr must be a positive integer");
  if (typeof dispatchedAt !== "number" || !Number.isFinite(dispatchedAt)) throw new Error("sh-await-verdict: dispatchedAt must be epoch milliseconds");
  const head = text(input.head, "head");
  if (!HEAD.test(head)) throw new Error("sh-await-verdict: head must be 40 lowercase hex characters");
  return {
    repo: text(input.repo, "repo"),
    pr,
    head,
    reviewerAgentId: text(input.reviewerAgentId, "reviewerAgentId"),
    reviewerSessionId: text(input.reviewerSessionId, "reviewerSessionId"),
    dispatchedAt,
  };
}

/**
 * Accepts only the final message of the dispatched agent and session, written after dispatch, whose block names this PR at
 * this head. The reader's fields are not trusted: the locator must point into the dispatched session too.
 */
export function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const final = messages.at(-1);
  if (!final) return { kind: "none" };
  if (final.agentId !== input.reviewerAgentId || final.sessionId !== input.reviewerSessionId) return { kind: "none" };
  if (final.locator?.source?.conversation?.nativeId !== input.reviewerSessionId) return { kind: "none" };
  if (typeof final.writtenAt !== "number" || !(final.writtenAt > input.dispatchedAt)) return { kind: "none" };
  const block = parseVerdictBlock(final.text);
  if (!block.ok) return { kind: "none" };
  if (block.repo !== input.repo || block.pr !== input.pr || block.head !== input.head) return { kind: "none" };
  return { kind: "verdict", verdict: block.verdict, head: block.head, locator: final.locator };
}

/** Polls until an acceptable block appears; the deadline ends the wait with `none`, and a failed read counts as nothing yet. */
export async function awaitVerdict(
  reader: ReviewerReader,
  input: AwaitVerdictInput,
  timing: AwaitVerdictTiming,
  signal: AbortSignal,
): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const messages = await reader.read(input).catch(() => []);
    const result = acceptVerdict(input, messages);
    if (result.kind === "verdict") return result;
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}

export interface ReviewWiring {
  reader: ReviewerReader;
  timeoutMs?: number;
  isFrozen?: IsFrozen;
}

/** With no reader wired the step answers `none` at once, so the owner gate decides; the reviewer identity arrives in the step input. */
export const reviewRoutes = (deps: ShepherdDeps, wiring?: ReviewWiring): readonly StepRoute[] => {
  const timing = { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? DEFAULT_POLL_MS, timeoutMs: wiring?.timeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS };
  const run = async (raw: unknown, signal: AbortSignal): Promise<AwaitVerdictResult> => {
    const input = parseAwaitVerdictInput(raw);
    return wiring ? awaitVerdict(wiring.reader, input, timing, signal) : { kind: "none" };
  };
  const isFrozen = wiring?.isFrozen ?? noFreezeStoreUntilTp523;
  return [
    codeRoute(AWAIT_VERDICT_STEP, deps.now, run),
    codeRoute(MERGE_EVIDENCE_STEP, deps.now, async (input: MergeEvidenceInput) => mergeEvidence(deps.port, input, isFrozen)),
  ];
};

const MergeEvidenceResult = z.looseObject({ head: z.string(), merge: z.looseObject({}), record: z.looseObject({}) });

/** A MERGE verdict at one head, carrying the facts and record collected there once; a replay reuses the step's output. */
export async function mergeVerdict(ctx: WorkflowContext, input: Omit<MergeEvidenceInput, "runId">): Promise<Verdict> {
  const request: MergeEvidenceInput = { ...input, runId: ctx.runId };
  const evidence = (await step(ctx, `${MERGE_EVIDENCE_STEP}:${input.head}`, request, MergeEvidenceResult)) as unknown as MergeEvidence;
  return { kind: "MERGE", headSha: input.head, evidence };
}

export const reviewPhase: ShepherdPhases["review"] = async () => ({ kind: "none" });
