import type { Check, StageUsage } from "./records.js";

/** A stage that failed after spending: the route records the spend before the run fails, so the report still shows it. */
export class StageFailure extends Error {
  constructor(message: string, readonly usage: StageUsage, readonly retries = 0, readonly checks: readonly Check[] = []) {
    super(message);
    this.name = "StageFailure";
  }
}
