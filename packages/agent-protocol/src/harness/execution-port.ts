import type { ConversationIdentity, ExecutionIdentity } from "../index.js";
import type { BoundedRunBase, HarnessCapabilityDescriptor, HarnessRunFailure, HarnessRunResult } from "./index.js";

/** Interface compatibility, independent of an adapter binary's own version. */
export const HARNESS_CONTRACT_VERSION = 1 as const;

/** Opaque references; producers keep native homes and credentials outside this contract. */
export interface HarnessAccountRef<H extends string = string> {
  readonly harness: H;
  readonly host: string;
  readonly accountId: string;
  readonly billingPoolId: string;
}

/** Intent resolved inside the selected adapter; consumers do not infer a provider from it. */
export interface HarnessModelIntent {
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** Persist the selected binding for resume; changing fallback creates a new execution. */
export interface HarnessExecutionBinding<H extends string = string> {
  readonly profileRef: string;
  readonly account: HarnessAccountRef<H>;
  readonly model?: HarnessModelIntent;
  readonly policyRevision: string;
}

export type HarnessOutputIntent<T = string> =
  | { readonly kind: "text" }
  | {
      readonly kind: "structured";
      readonly jsonSchema: Readonly<Record<string, unknown>>;
      /** Adapter validates output again after any native schema constraint. */
      readonly parse: (value: unknown) => T;
    };

/** Metadata and output intent only; native SDK options remain private to adapter modules. */
export interface HarnessExecutionRequest<H extends string = string, T = string> extends BoundedRunBase<H> {
  readonly harness: H;
  readonly binding: HarnessExecutionBinding<H>;
  readonly output?: HarnessOutputIntent<T>;
}

/** In-process port; a conforming implementation still needs independently qualified runtime evidence. */
export interface HarnessExecutionPort<H extends string = string> {
  readonly contractVersion: typeof HARNESS_CONTRACT_VERSION;
  readonly descriptor: HarnessCapabilityDescriptor<H>;
  run<T = string>(request: HarnessExecutionRequest<H, T>): Promise<HarnessRunResult<T, H>>;
}

/** A transport acknowledgment is not a terminal result or an authenticated authority grant. */
export type HarnessDispatchReceipt<H extends string = string> =
  | {
      readonly state: "accepted";
      readonly harness: H;
      readonly execution: ExecutionIdentity;
      readonly binding: HarnessExecutionBinding<H>;
    }
  | {
      readonly state: "running";
      readonly harness: H;
      readonly execution: ExecutionIdentity;
      readonly binding: HarnessExecutionBinding<H>;
      readonly observedAtMs: number;
      readonly conversation?: ConversationIdentity;
    }
  | { readonly state: "refused"; readonly harness: H; readonly failure: HarnessRunFailure };
