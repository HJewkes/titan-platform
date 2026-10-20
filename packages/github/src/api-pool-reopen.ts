import type { CallClass } from "./github-failure.js";

/** What the pool's `probe` (a `GET /rate_limit` as the identity) resolves to; absent `status` is a network failure. */
export interface RateLimitProbeAnswer {
  status?: number;
  /** GitHub's JSON body: `{ resources: { core: { remaining, reset }, graphql: { ... }, ... } }`. */
  body?: unknown;
  networkError?: boolean;
}

/** `pass` lets one canary out; `rearm` keeps the pair closed to `resetAt` with its streak untouched. */
export type ProbeVerdict = { kind: "pass" } | { kind: "auth" } | { kind: "rearm"; resetAt: number; reason: string };

/** A failed probe says nothing about the limit, so it waits the base step and never doubles. */
export const PROBE_REARM_MS = 60_000;

/** Secondary limits have no bucket of their own, so a mutation trip reads core and leaves the rest to its canary. */
export function probedBucket(callClass: CallClass, trippedBucket: string | undefined): string {
  if (callClass === "mutation") return "core";
  return trippedBucket ?? (callClass === "graphql" ? "graphql" : "core");
}

/** `answer` is undefined when the probe threw. */
export function probeVerdict(answer: RateLimitProbeAnswer | undefined, bucket: string, now: number): ProbeVerdict {
  if (answer?.status === 401) return { kind: "auth" };
  const rearm = (reason: string, resetAt = now + PROBE_REARM_MS): ProbeVerdict => ({ kind: "rearm", resetAt, reason });
  if (answer === undefined || answer.networkError || answer.status === undefined) return rearm("rate_limit probe failed");
  if (answer.status !== 200) return rearm(`rate_limit probe answered ${answer.status}`);
  const resource = resourceOf(answer.body, bucket);
  if (!resource) return rearm(`rate_limit probe lists no ${bucket} bucket`);
  if (resource.remaining > 0) return { kind: "pass" };
  const resetAt = resource.reset * 1000;
  return rearm(`${bucket} still at 0 remaining`, resetAt > now ? resetAt : now + PROBE_REARM_MS);
}

function resourceOf(body: unknown, bucket: string): { remaining: number; reset: number } | undefined {
  const resources = field(body, "resources");
  const resource = field(resources, bucket);
  const remaining = field(resource, "remaining");
  const reset = field(resource, "reset");
  return typeof remaining === "number" && typeof reset === "number" ? { remaining, reset } : undefined;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : undefined;
}
