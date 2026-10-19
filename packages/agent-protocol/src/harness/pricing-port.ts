import type { UsageMeasurement } from "../index.js";
import type { CacheWriteSplit } from "./source.js";

/** Versioned policy metadata, never executable code supplied by a profile. */
export interface HarnessPricePolicyRef {
  readonly id: string;
  readonly version: string;
}

/** Evidence for the dated catalog row and accounting rules selected by an adapter. */
export interface HarnessPriceCatalogRef {
  readonly id: string;
  readonly version: string;
  readonly provider: string;
  readonly model: string;
  readonly effectiveFrom: string;
  readonly matchingPolicy: HarnessPricePolicyRef;
  readonly accountingPolicy: HarnessPricePolicyRef;
}

/** Evidence paired with the same normalized usage observation; no native fields are required. */
export interface HarnessPricingContext {
  readonly cacheWriteSplit?: Readonly<CacheWriteSplit>;
}

/** Unpriced is explicit; a reported zero remains distinct from an unavailable price. */
export type HarnessPriceQuote =
  | {
      readonly status: "priced";
      readonly cost: NonNullable<UsageMeasurement["cost"]> & { readonly kind: "reported" };
      readonly basis: { readonly kind: "reported"; readonly source: string };
    }
  | {
      readonly status: "priced";
      readonly cost: NonNullable<UsageMeasurement["cost"]> & { readonly kind: "estimate" };
      /** The current normalized record source, without reconstructing its original catalog. */
      readonly basis: { readonly kind: "existing_estimate"; readonly source: string };
    }
  | {
      readonly status: "priced";
      readonly cost: NonNullable<UsageMeasurement["cost"]> & { readonly kind: "estimate" };
      readonly basis: { readonly kind: "catalog"; readonly atMs: number; readonly catalog: HarnessPriceCatalogRef };
    }
  | { readonly status: "unpriced"; readonly reason: string };

/** Pure, bound quote service; implementations own matching and accounting, not consumers. */
export interface HarnessPricingPort<H extends string = string> {
  readonly harness: H;
  /** atMs is event time in epoch milliseconds. This port neither sums usage nor mutates it. */
  quote(measurement: UsageMeasurement, atMs: number, context?: HarnessPricingContext): HarnessPriceQuote;
}
