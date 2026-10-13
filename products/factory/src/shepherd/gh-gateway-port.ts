import type { GatewayBudget } from "@titan-design/github";

/**
 * One gateway read. `source` says where the body came from: GitHub (a 304 included), this gateway's memory within
 * `maxAgeMs`, or the PR snapshot, whose body is the port's `PullRequest`, not GitHub's JSON. A `raw` read never gets
 * the snapshot.
 */
export interface GhReadAnswer {
  status: number;
  body: unknown;
  /** ISO time the body was read from GitHub or the snapshot. */
  at: string;
  /** True when GitHub refused or the lane is cooling down, so this is the last answer the gateway had. */
  stale: boolean;
  source: "github" | "memory" | "snapshot";
}

interface GhReadRequest {
  path: string;
  maxAgeMs?: number;
  caller?: string;
  /** Skips the PR snapshot, for callers that parse GitHub's JSON and would read the snapshot's `PullRequest` as a miss. */
  raw?: boolean;
}

/** Kept apart from `gh-gateway.ts` so `services.ts` stays a leaf: the gateway itself imports the registry. */
export interface GhGateway {
  read(request: GhReadRequest): Promise<GhReadAnswer>;
  budget(): GatewayBudget;
}
