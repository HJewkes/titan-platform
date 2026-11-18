import type { StepUsage } from "./types.js";

export interface StepFailureDetail {
  /** The last attempt's failure could clear on a fresh call; `false` means repeating it would fail the same way. */
  retryable?: boolean;
  /** Cost of every failed attempt, when the runner reported it. */
  usage?: StepUsage;
  /** The host's class for this failure, set where it failed, so no reader has to classify the text. */
  errorClass?: string;
}

export class StepFailedError extends Error {
  readonly retryable: boolean;
  readonly usage: StepUsage | undefined;
  readonly errorClass: string | undefined;

  constructor(
    readonly stepId: string,
    readonly iteration: number,
    readonly reason: string,
    detail: StepFailureDetail = {},
  ) {
    super(`step ${stepId} (iteration ${iteration}) failed: ${reason}`);
    this.name = "StepFailedError";
    this.retryable = detail.retryable ?? false;
    this.usage = detail.usage;
    this.errorClass = detail.errorClass;
  }
}

export type StepOutputFailureKind = "not_json" | "schema" | "too_large";

/** A dispatch whose output failed its schema. Never retryable: the same prompt would produce the same kind of payload. */
export class StepOutputInvalidError extends StepFailedError {
  constructor(
    stepId: string,
    iteration: number,
    readonly kind: StepOutputFailureKind,
    readonly issues: string[],
    usage?: StepUsage,
  ) {
    super(stepId, iteration, `output ${kind}: ${issues.join("; ")}`, { retryable: false, usage });
    this.name = "StepOutputInvalidError";
  }
}

/** The authority table denied the action; no gate was opened, and repeating the request is denied the same way. */
export class AuthorityDeniedError extends StepFailedError {
  constructor(
    stepId: string,
    iteration: number,
    readonly ruleId: string | null,
    readonly denial: string,
  ) {
    super(stepId, iteration, `authority denied: ${denial}`, { retryable: false });
    this.name = "AuthorityDeniedError";
  }
}

/** The rule's gate settled without a valid approval: the owner refused, or the answer's resolver fails the rule. */
export class AuthorityRefusedError extends StepFailedError {
  constructor(
    stepId: string,
    iteration: number,
    readonly ruleId: string,
    readonly gateId: string,
    readonly refusal: string,
  ) {
    super(stepId, iteration, `authority gate ${gateId} refused: ${refusal}`, { retryable: false });
    this.name = "AuthorityRefusedError";
  }
}
