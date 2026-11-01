import { DEFAULT_SONNET_FOR, isUsageLimit, readMalformed, type AwaitVerdictResult } from "@titan-design/review-panel";
import type { FailureClass } from "./types.js";

/** What one member's dispatch step recorded: a started session, a start that never showed, or a spawn the dispatch refused. */
export type DispatchRecord =
  | { kind: "started"; name: string; profile: string; degraded: boolean; agentId: string; sessionId: string; dispatchedAt: number; startedAt: number }
  | { kind: "never-started"; name: string; profile: string; degraded: boolean }
  /** `error` is the thrown error's class name, `message` its text. */
  | { kind: "refused"; name: string; profile: string; degraded: boolean; error: string; message: string };

/** What one await or late read recorded; `timeout` means the verdict deadline passed with no final answer. */
export type AwaitRecord = AwaitVerdictResult | { kind: "timeout" };

/**
 * One member failure. `detail` goes into the fixer fingerprint (a profile, an error class, a refusal); `text` is what a
 * repeat is compared on, so the same refusal twice is deterministic and goes to the fixer without spending the rest of its row.
 */
export interface ClassifiedFailure {
  class: FailureClass;
  detail?: string;
  text?: string;
}

/** The broker was down, so nothing was asked of it; agent-dispatch's `BrokerUnavailableError`. */
const BROKER_DOWN = "BrokerUnavailableError";
/** agent-dispatch's installed-profile guard (tp#1986); its refusals name the profile this way. */
const PROFILE_REFUSAL = /\b(?:installed profile '|invalid profile name)/;

function refusalClass(dispatch: Extract<DispatchRecord, { kind: "refused" }>, sonnetFor: Record<string, string>): ClassifiedFailure {
  if (dispatch.error === BROKER_DOWN) return { class: "never-started" };
  if (PROFILE_REFUSAL.test(dispatch.message)) return { class: "start-refused:profile", detail: dispatch.profile };
  // The spawn gate names no class of its own, so a refused premium member is read as headroom, as review-panel's fallback reads it.
  if (!dispatch.degraded && Object.hasOwn(sonnetFor, dispatch.profile)) return { class: "start-refused:headroom", detail: dispatch.profile };
  return { class: "start-refused:other", detail: dispatch.error, text: dispatch.message };
}

/**
 * Why one member attempt reached no verdict, or undefined when it reached one. Pure: it reads only the attempt's recorded
 * dispatch and await. A silent session or a WAIT keeps the await polling, so either ends as a timeout.
 */
export function classifyFailure(dispatch: DispatchRecord, awaited?: AwaitRecord, sonnetFor: Record<string, string> = DEFAULT_SONNET_FOR): ClassifiedFailure | undefined {
  if (dispatch.kind === "never-started") return { class: "never-started" };
  if (dispatch.kind === "refused") return refusalClass(dispatch, sonnetFor);
  if (awaited?.kind === "verdict") return undefined;
  if (awaited === undefined || awaited.kind === "timeout") return { class: "timeout" };
  if (isUsageLimit(awaited)) return { class: "usage-limit" };
  const malformed = readMalformed(awaited);
  return malformed ? { class: "malformed", detail: malformed.refusal, text: malformed.refusal } : { class: "timeout" };
}

/** The same class with the same text: a fresh attempt would only repeat it. */
export const repeats = (last: ClassifiedFailure | undefined, next: ClassifiedFailure): boolean =>
  last !== undefined && next.text !== undefined && last.class === next.class && last.text === next.text;
