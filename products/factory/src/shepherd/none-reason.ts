import { DEPTH_FLOOR_REASON, isUsageLimit, readMalformed } from "@titan-design/review-panel";
import type { StepResult } from "@titan-design/workflow";
import { z } from "zod";
import { SILENT_AFTER_CORRECTION, UNPARSED_AFTER_CORRECTION, isCorrectionFailure } from "./correct-verdict.js";

export const NONE_KINDS = [
  "seat-wait",
  "seat-read",
  "usage-limit",
  "malformed",
  "correction-failed",
  "reviewer-wait",
  "depth-floor",
  "deadline",
  "reviewer-gone",
  "dispatch-refused",
  "not-started",
  "unknown",
] as const;
export type NoneKind = (typeof NONE_KINDS)[number];
export interface NoneReason {
  kind: NoneKind;
  text: string;
}

/** Seat and refusal texts can run long; a list row stays readable at this cut. */
const MAX_TEXT = 120;
const SEAT_PREFIX = "seat check: ";
const SEAT_WAIT = /^seat check: (\S+) said WAIT/;

const cut = (text: string): string => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`);
const label = (kind: NoneKind, text: string): NoneReason => ({ kind, text: cut(text) });
const AnyRecord = z.record(z.string(), z.unknown());
const asRecord = (value: unknown): Record<string, unknown> | undefined => AnyRecord.safeParse(value).data;

function seatReason(record: Record<string, unknown>, reason: string | undefined): NoneReason | undefined {
  const seat = typeof record.seat === "string" ? record.seat : reason?.match(SEAT_WAIT)?.[1];
  if (seat !== undefined) return label("seat-wait", `seat WAIT from ${seat}${record.seatHeld === undefined ? "" : ", Shepherd MERGE held"}`);
  return reason?.startsWith(SEAT_PREFIX) ? label("seat-read", reason.slice(SEAT_PREFIX.length)) : undefined;
}

function usageLimitReason(record: Record<string, unknown>): NoneReason {
  const resets = typeof record.resetsAt === "number" && Number.isFinite(record.resetsAt) ? ` (resets ${new Date(record.resetsAt).toISOString().slice(0, 16)}Z)` : "";
  return label("usage-limit", `reviewer hit the usage limit${resets}`);
}

/** A correction's reply that still gave no verdict is worded as the workflow words it, so seats read one sentence for both. */
function correctedReason(record: Record<string, unknown>): NoneReason {
  const malformed = readMalformed(record);
  return label("correction-failed", malformed ? `${UNPARSED_AFTER_CORRECTION} (${malformed.refusal})` : SILENT_AFTER_CORRECTION);
}

function endedReason(ended: unknown): NoneReason {
  if (ended === "deadline") return label("deadline", "no verdict before the wait ran out");
  if (ended === "reviewer-gone") return label("reviewer-gone", "reviewer exited with no verdict");
  return label("unknown", "no verdict read");
}

/** Why one stored await (or correction) ended in `none`; precedence runs top-down, so a seat WAIT outranks a malformed record it carries. */
export function awaitNoneReason(output: unknown, corrected = false): NoneReason | undefined {
  const record = asRecord(output);
  if (record?.kind !== "none") return undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const seat = seatReason(record, reason);
  if (seat) return seat;
  if (isUsageLimit({ kind: "none", reason: record.reason, notice: record.notice })) return usageLimitReason(record);
  if (corrected) return correctedReason(record);
  const malformed = readMalformed(record);
  if (malformed) return label("malformed", `malformed verdict refused: ${malformed.refusal}`);
  if (isCorrectionFailure(reason)) return label("correction-failed", reason!);
  if (reason === "wait") return label("reviewer-wait", "reviewer said WAIT");
  if (reason === DEPTH_FLOOR_REASON) return label("depth-floor", "verdict below the depth floor");
  return endedReason(record.ended);
}

/** Why one stored review dispatch started no reviewer; a started dispatch has no reason. */
export function dispatchNoneReason(output: unknown): NoneReason | undefined {
  const record = asRecord(output);
  if (record?.kind === "dispatched") return undefined;
  if (typeof record?.refused === "string") return label("dispatch-refused", `dispatch refused: ${record.refused}`);
  if (record?.notStarted === true) return label("not-started", "no reviewer started (broker busy)");
  if (record?.kind !== "none") return undefined;
  return typeof record.reason === "string" ? label("not-started", record.reason) : label("unknown", "no verdict read");
}

type Reader = (output: unknown) => NoneReason | undefined;

/** The head-level review steps, by name; a panel member's `<name>:<head>:<shape>` is not the head's review. */
function readerFor(stepId: string): Reader | undefined {
  const [name, , suffix] = stepId.split(":");
  if (name === "sh-review" && suffix === undefined) return dispatchNoneReason;
  if (name === "sh-await-verdict" && suffix === undefined) return (output) => awaitNoneReason(output);
  if (name === "sh-await-verdict" && suffix === "corrected") return (output) => awaitNoneReason(output, true);
  if (name === "sh-late-verdict" && suffix === undefined) return (output) => awaitNoneReason(output);
  if (name === "sh-correct-verdict" && suffix === undefined) return correctAskReason;
  return undefined;
}

/** The ask for a correction itself: `asked` waits on the reply step, a `none` is a correction that never reached the reviewer. */
function correctAskReason(output: unknown): NoneReason | undefined {
  const record = asRecord(output);
  if (record?.kind !== "none") return undefined;
  return label("correction-failed", `correction failed: ${typeof record.reason === "string" ? record.reason : "no reason recorded"}`);
}

/** The dispatch writer nests its outcome under data.result; rows written before that kept it at the top level. */
function outputOf(step: StepResult): unknown {
  const data = asRecord(step.data);
  return data !== undefined && "result" in data ? data.result : data;
}

/** Why the newest head-level review step ended in `none`, given steps oldest first; undefined when it gave a verdict or is still waiting. */
export function lastNoneReason(steps: readonly StepResult[]): NoneReason | undefined {
  const newest = steps.filter((step) => readerFor(step.stepId) !== undefined).at(-1);
  return newest && readerFor(newest.stepId)!(outputOf(newest));
}

/** Why the last await gave none, for a row's blockers; nothing when the stall line already says it. */
export function lastAwaitClause({ lastNone, stalled }: { lastNone?: { text: string } | null; stalled: { reason: string } | null }): string | undefined {
  if (!lastNone) return undefined;
  const clause = `last await: ${lastNone.text}`;
  return stalled?.reason.includes(clause) ? undefined : clause;
}
