import { ciEvent, fromCheckRunDelivery, fromStatusDelivery, type CiObservation } from "../event-log/ci-keys.js";
import type { IdentityEvent, TransitionEvent } from "../event-log/event-log.js";
import { fromPullRequestDelivery, fromPushDelivery, fromReviewDelivery, fromRulesetDelivery, repoEvent, type RepoObservation } from "../event-log/repo-keys.js";
import type { Projector } from "./answer.js";

type Projected = Exclude<ReturnType<Projector>, "ignored">;
type Body = Record<string, unknown>;

/** The answer core stamps source, delivery id and observation time; a projection carries none of them. */
const TRANSPORT = { source: "webhook", observedAt: "" } as const;

function bare(event: IdentityEvent | TransitionEvent): Projected {
  const { source: _source, deliveryId: _deliveryId, observedAt: _observedAt, ...rest } = event;
  return rest;
}

const fromCi = (observation: CiObservation | undefined): Projected | "ignored" => (observation === undefined ? "ignored" : bare(ciEvent(observation, TRANSPORT)));
const fromRepo = (observation: RepoObservation | undefined): Projected | "ignored" => (observation === undefined ? "ignored" : bare(repoEvent(observation, TRANSPORT)));

/** A `pull_request` delivery reports head, base and ending at once; each row of the table keeps the one kind it names. */
const pullRequestKind =
  (...kinds: RepoObservation["kind"][]) =>
  (body: Body): Projected | "ignored" =>
    fromRepo(fromPullRequestDelivery(body).find((observation) => kinds.includes(observation.kind)));

const baseChanged = (body: Body): boolean => typeof body.changes === "object" && body.changes !== null && "base" in body.changes;

interface IngressKind {
  event: string;
  /** Absent when the event carries no action (`status`, `push`) or every action counts. */
  actions?: readonly string[];
  /** The kinds the row can project; `closed` gives PRMerged or PRClosed. */
  kinds: readonly string[];
  when?: (body: Body) => boolean;
  project: (body: Body) => Projected | "ignored";
}

/** Declared, so TP-3099's kind-set diff reads what the ingress can write. Anything not listed is ignored. */
export const INGRESS_KINDS: readonly IngressKind[] = [
  { event: "check_run", actions: ["completed"], kinds: ["CIConcluded"], project: (body) => fromCi(fromCheckRunDelivery(body)) },
  { event: "status", kinds: ["CIConcluded"], project: (body) => fromCi(fromStatusDelivery(body)) },
  { event: "pull_request", actions: ["closed"], kinds: ["PRMerged", "PRClosed"], project: pullRequestKind("PRMerged", "PRClosed") },
  { event: "pull_request", actions: ["opened", "synchronize", "reopened"], kinds: ["HeadPushed"], project: pullRequestKind("HeadPushed") },
  { event: "pull_request", actions: ["edited"], kinds: ["BaseChanged"], when: baseChanged, project: pullRequestKind("BaseChanged") },
  { event: "pull_request_review", actions: ["submitted", "dismissed"], kinds: ["ReviewSubmitted", "ReviewDismissed"], project: (body) => fromRepo(fromReviewDelivery(body)) },
  { event: "push", kinds: ["MainMoved"], project: (body) => fromRepo(fromPushDelivery(body)) },
  { event: "repository_ruleset", kinds: ["RulesChanged"], project: (body) => fromRepo(fromRulesetDelivery(body)) },
];

const isBody = (payload: unknown): payload is Body => typeof payload === "object" && payload !== null && !Array.isArray(payload);

/** Throws on a malformed payload of a listed kind, which the answer core turns into 422. */
export const projectDelivery: Projector = (event, payload) => {
  if (!isBody(payload)) return "ignored";
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const row = INGRESS_KINDS.find((candidate) => candidate.event === event && (candidate.actions === undefined || (action !== undefined && candidate.actions.includes(action))) && (candidate.when?.(payload) ?? true));
  return row === undefined ? "ignored" : row.project(payload);
};
