export type PlanStoreErrorKind = "invalid" | "not-found" | "lock-timeout";

/** A plan-store refusal the host maps onto its own error kinds; `kind` says which. */
export class PlanStoreError extends Error {
  readonly kind: PlanStoreErrorKind;

  constructor(kind: PlanStoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlanStoreError";
    this.kind = kind;
  }
}
