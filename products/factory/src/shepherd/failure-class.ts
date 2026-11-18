import { StepFailedError, type StepRunOutcome, type WorkflowFn } from "@titan-design/workflow";
import { redactForEvidence } from "../redact.js";
import { isOneOf } from "../narrow.js";
import { legacyFailureClassOf } from "./failure-class-legacy.js";
import { FAILURE_CLASSES, type FailureClass } from "./failure-class-names.js";
import { ghFailureClass } from "./gh-failure-class.js";

export { FAILURE_CLASSES, type FailureClass } from "./failure-class-names.js";

/** Thrown where a failure has a class of its own; every reader takes `errorClass`, never the message. */
export class ShepherdFailure extends Error {
  constructor(
    readonly errorClass: FailureClass,
    message: string,
  ) {
    super(message);
    this.name = "ShepherdFailure";
  }
}

const isFailureClass = (value: unknown): value is FailureClass => typeof value === "string" && isOneOf(FAILURE_CLASSES, value);

/** A recorded class; a code step that recorded none, or one this build does not know, is `other`. */
export function recordedFailureClass(recorded: string | undefined): FailureClass {
  return isFailureClass(recorded) ? recorded : "other";
}

/** A failed run's class: the one recorded where it failed. Only a row with no `error_class` at all, written before it existed, reads its text. */
export function failureClassOf(error: string, recorded: string | null | undefined): FailureClass {
  if (recorded === null || recorded === undefined) return legacyFailureClassOf(error);
  return recordedFailureClass(recorded);
}

/** The class a step's own id gives it, for a failed step that recorded none: its route is the failure site. */
function stepIdClass(stepId: string): FailureClass {
  const route = stepId.split(":")[0];
  return route === "land-rules" || route === "update-branch" ? route : "other";
}

function ownClass(error: unknown): FailureClass | undefined {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof ShepherdFailure) return at.errorClass;
  }
  return undefined;
}

/**
 * The class a failed code step records, set by the route it failed in. The order is the one the classes were always
 * ranked by: a thrown `ShepherdFailure`, a GitHub rate limit, `land-rules`, a GitHub server-side failure, `update-branch`.
 */
export function stepFailureClass(route: string, error: unknown): FailureClass {
  const own = ownClass(error);
  if (own) return own;
  const gh = ghFailureClass(error);
  if (gh === "gh-rate-limit" || (gh === "gh-api-5xx" && route !== "land-rules")) return gh;
  return stepIdClass(route);
}

/** A route's own failed outcome, for a wrapper that fails before its code step runs: redacted text, and the class set here. */
export function failedStep(route: string, error: unknown): StepRunOutcome {
  return { ok: false, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false, errorClass: stepFailureClass(route, error) };
}

/** A rejected run's class: what its failed step recorded, else the step's id, else a thrown `ShepherdFailure`, else `other`. */
function runFailureClass(error: unknown): FailureClass {
  if (error instanceof StepFailedError) return isFailureClass(error.errorClass) ? error.errorClass : stepIdClass(error.stepId);
  return ownClass(error) ?? "other";
}

/** `[<class>] <text>`, unchanged when the text already carries that prefix; the prefix is for people, the field for readers. */
function withFailureClass(error: string, failureClass: FailureClass): string {
  const prefix = `[${failureClass}] `;
  return error.startsWith(prefix) ? error : `${prefix}${error}`;
}

/**
 * The workflow runtime stores a rejected run's `errorClass` field in `workflow_run.error_class`, so the class goes on at
 * the Shepherd boundary; the error object is kept so the runtime's instanceof checks still hold.
 */
export function classifyingFailures(run: WorkflowFn): WorkflowFn {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (error) {
      const errorClass = runFailureClass(error);
      if (!(error instanceof Error)) throw Object.assign(new Error(withFailureClass(String(error), errorClass)), { errorClass });
      error.message = withFailureClass(error.message, errorClass);
      throw Object.assign(error, { errorClass });
    }
  };
}
