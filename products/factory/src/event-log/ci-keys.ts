import { z } from "zod";
import type { IdentityEvent } from "./event-log.js";

/** The terminal commit-status states; `pending` and GraphQL's `expected` are not a conclusion. */
const TERMINAL_STATES = new Set(["success", "failure", "error"]);

/** One concluded CI occurrence, however it was observed. */
export interface CiObservation {
  type: "check" | "status";
  /** Lowercased `owner/name`. */
  repo: string;
  head: string;
  /** The check run's name or the status context. */
  context: string;
  /** Check-run database id; absent for a status. */
  checkRunId?: number;
  /** Lowercased conclusion or state. */
  outcome: string;
  /** `completed_at` or `created_at`, UTC seconds. */
  at: string;
}

/** Builds the occurrence key; injectable so a test can swap in the literal context-only contract. */
export type CiKeyFn = (observation: CiObservation) => string;

export const ciKey: CiKeyFn = (o) =>
  o.type === "check"
    ? `v1|CIConcluded|${o.repo}|check|${o.head}|${o.checkRunId}|${o.outcome}|${o.at}`
    : `v1|CIConcluded|${o.repo}|status|${o.head}|${o.context}|${o.outcome}|${o.at}`;

/** UTC seconds, so a webhook's `Z` stamp and a GraphQL stamp with an offset or fraction agree. */
export function utcSeconds(stamp: string): string {
  const time = new Date(stamp);
  if (Number.isNaN(time.getTime())) throw new RangeError(`not a timestamp: ${stamp}`);
  return time.toISOString().replace(/\.\d+Z$/, "Z");
}

const Repository = z.object({ full_name: z.string() });

const CheckRunDelivery = z.object({
  action: z.string(),
  check_run: z.object({
    id: z.number(),
    name: z.string(),
    head_sha: z.string(),
    conclusion: z.string().nullable(),
    completed_at: z.string().nullable(),
  }),
  repository: Repository,
});

const StatusDelivery = z.object({
  sha: z.string(),
  context: z.string(),
  state: z.string(),
  created_at: z.string(),
  repository: Repository,
});

/** A webhook `check_run` delivery; only a completed run with a conclusion and a stamp is an occurrence. */
export function fromCheckRunDelivery(body: unknown): CiObservation | undefined {
  const { action, check_run: run, repository } = CheckRunDelivery.parse(body);
  if (action !== "completed" || run.conclusion === null || run.completed_at === null) return undefined;
  return {
    type: "check",
    repo: repository.full_name.toLowerCase(),
    head: run.head_sha,
    context: run.name,
    checkRunId: run.id,
    outcome: run.conclusion.toLowerCase(),
    at: utcSeconds(run.completed_at),
  };
}

/** A webhook `status` delivery in a terminal state. */
export function fromStatusDelivery(body: unknown): CiObservation | undefined {
  const status = StatusDelivery.parse(body);
  const outcome = status.state.toLowerCase();
  if (!TERMINAL_STATES.has(outcome)) return undefined;
  return { type: "status", repo: status.repository.full_name.toLowerCase(), head: status.sha, context: status.context, outcome, at: utcSeconds(status.created_at) };
}

/** The statusCheckRollup context nodes the GraphQL backstop reads (packages/github backstop-query). */
export type BackstopContext =
  | { __typename: "CheckRun"; databaseId: number; name: string; status: string; conclusion: string | null; completedAt: string | null }
  | { __typename: "StatusContext"; context: string; state: string; createdAt: string };

/** One GraphQL context node on `repo@head`; a check still running, or a pending status, is no occurrence. */
export function fromBackstopContext(repo: string, head: string, node: BackstopContext): CiObservation | undefined {
  const lowered = repo.toLowerCase();
  if (node.__typename === "StatusContext") {
    const outcome = node.state.toLowerCase();
    if (!TERMINAL_STATES.has(outcome)) return undefined;
    return { type: "status", repo: lowered, head, context: node.context, outcome, at: utcSeconds(node.createdAt) };
  }
  if (node.status !== "COMPLETED" || node.conclusion === null || node.completedAt === null) return undefined;
  return { type: "check", repo: lowered, head, context: node.name, checkRunId: node.databaseId, outcome: node.conclusion.toLowerCase(), at: utcSeconds(node.completedAt) };
}

export interface Transport {
  source: "webhook" | "backstop";
  observedAt: string;
  /** `X-GitHub-Delivery`, webhook only. */
  deliveryId?: string;
}

/** The event to append for one observation; `key` defaults to the plan's v1 occurrence key. */
export function ciEvent(observation: CiObservation, transport: Transport, key: CiKeyFn = ciKey): IdentityEvent {
  return {
    rule: "identity",
    source: transport.source,
    kind: "CIConcluded",
    repo: observation.repo,
    subject: `${observation.repo}@${observation.head}`,
    keys: { type: observation.type, context: observation.context, outcome: observation.outcome, ...(observation.checkRunId !== undefined && { checkRunId: observation.checkRunId }) },
    occurrenceKey: key(observation),
    ...(transport.deliveryId !== undefined && { deliveryId: `webhook:${transport.deliveryId}` }),
    observedAt: transport.observedAt,
    sourceAt: observation.at,
    payload: { type: observation.type, context: observation.context, outcome: observation.outcome, at: observation.at },
  };
}
