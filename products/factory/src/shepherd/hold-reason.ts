import { z } from "zod";
import { holdClassOf } from "./g10-release.js";

/**
 * The closed list of break-glass hold classes in charter section 8; add a class here when the charter adds it, or seats
 * holding under it are refused. The check runs at the `shepherd.hold` command only, so Shepherd's own holds never pass through it.
 */
export const HOLD_CLASSES = ["serve-down", "stalled", "no-reviewer", "run-failed", "visual-gate2", "g10-review", "g10-adversary"] as const;
export type HoldClass = (typeof HOLD_CLASSES)[number];

/** Gate classes, not factory defects: they cite no task. Every other class names the open task for its defect. */
export const TASKLESS_CLASSES: ReadonlySet<HoldClass> = new Set(["visual-gate2", "g10-review", "g10-adversary"]);

/** Syntax only: whether the task is open is not checked here. */
const TASK_ID = /\b[A-Z]{2,5}-\d+\b/;

export type HoldReasonCheck = { ok: true; holdClass: HoldClass } | { ok: false; refusal: string };

const isHoldClass = (value: string | undefined): value is HoldClass => (HOLD_CLASSES as readonly string[]).includes(value ?? "");

const SHAPE =
  `write it as "<class>: <detail>; <task id>", where <class> is the text before the first ":" and one of ${HOLD_CLASSES.join(", ")}; ` +
  `every class except ${[...TASKLESS_CLASSES].join(", ")} must cite the task for its factory defect, an ID like TP-123 or CC-45. ` +
  "A seat path or interim procedure is not a hold reason (charter section 8).";

/** The class is read exactly as `holdClassOf` reads it, so a reason that passes here is one Shepherd's g10 release can classify. */
export function checkHoldReason(reason: string): HoldReasonCheck {
  const holdClass = holdClassOf(reason);
  if (!isHoldClass(holdClass)) return { ok: false, refusal: `hold refused, nothing was held: "${holdClass ?? reason}" is not a hold class; ${SHAPE}` };
  if (!TASKLESS_CLASSES.has(holdClass) && !TASK_ID.test(reason)) return { ok: false, refusal: `hold refused, nothing was held: a ${holdClass} hold names no task ID; ${SHAPE}` };
  return { ok: true, holdClass };
}

/** The `shepherd.hold` reason argument: a refusal is an argument error, exit 65, raised before the command reads or writes anything. */
export const HoldReasonSchema = z.string().superRefine((reason, ctx) => {
  const check = checkHoldReason(reason);
  if (!check.ok) ctx.addIssue({ code: "custom", message: check.refusal });
});

export interface HoldResult {
  runId: string;
  held: { reason: string; reviewer?: string } | null;
}
