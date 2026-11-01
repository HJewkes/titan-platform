import {
  extractConcerns,
  extractFriction,
  lineCluster,
  parseReport,
  type CiState,
  type ContractReport,
  type FrictionCluster,
  type WorkerReportRecord,
} from "@titan-design/session-analytics";

/**
 * Worker-report intake (W1), shadow only: each report becomes a row of parsed contract fields, concern classes
 * and the closeout actions the rule table would take. Nothing here acts; the rows are compared with what the
 * coordinator did.
 */

type ConcernClass = "visibility-denied" | "ci-unread" | "follow-up-filed" | "pre-existing-failure" | "could-not-verify";

/** First match wins: a denied visibility check is usually also a thing the worker could not verify. */
const CONCERN_RULES: readonly [ConcernClass, RegExp][] = [
  ["visibility-denied", /\b(?:visibility|public repo|leak[- ](?:guard|scan))\b.*\b(?:refused|denied|blocked)\b|\b(?:refused|denied)\b.*\bvisibility\b/i],
  ["ci-unread", /\bCI\b.{0,40}\b(?:not (?:read|checked|watched|waited)|unread|still (?:running|pending)|not (?:yet )?(?:started|finished))\b|\bdid not wait (?:on|for) CI\b/i],
  ["follow-up-filed", /\b(?:filed|opened|logged)\b.{0,30}\b[A-Z]{2,}-\d+\b|\b[A-Z]{2,}-\d+\b.{0,30}\b(?:filed|tracks (?:it|this))\b/],
  ["pre-existing-failure", /\bpre-?existing\b|\b(?:fails?|failing|red) on (?:origin\/)?main\b|\bon main too\b|\bsame (?:failures?|timeouts?) on (?:the )?base\b/i],
  [
    "could-not-verify",
    /\b(?:could not|couldn't|can't|cannot|did not|didn't|unable to) (?:verify|finish|run|test|check|reproduce|confirm)\b|\bnot verified\b|\bonly be checked after\b|\buntested\b/i,
  ],
];

export const concernClass = (text: string): ConcernClass | "residual" => CONCERN_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "residual";

type IntakeAction = "verify-head" | "ensure-shepherd" | "copy-plan" | "note-task" | "retire" | "park-tree" | "count-friction" | "resume-after-backoff" | "enqueue-for-seat";

/** Closeout leaves the seat out; every other suggestion puts the report in front of it. */
export const isCloseout = (actions: readonly IntakeAction[]): boolean => !actions.includes("enqueue-for-seat");

/** Blocked causes a resume after a backoff can clear without the seat. */
const RETRYABLE: ReadonlySet<FrictionCluster> = new Set(["denials", "broker-infra"]);

interface IntakeConcern {
  class: ConcernClass | "residual";
  text: string;
}

export interface IntakeRow {
  eventId: number;
  at: string;
  agent: string;
  coordinator: string;
  status: ContractReport["status"];
  pr: string | null;
  head: string | null;
  ci: CiState | null;
  concerns: IntakeConcern[];
  friction: FrictionCluster[];
  actions: IntakeAction[];
}

const hasPr = (report: ContractReport): boolean => report.pr !== undefined && !/^(?:none|n\/a)\b/i.test(report.pr);

/** W1's rule table over one parsed report. */
function suggestActions(report: ContractReport, concerns: readonly IntakeConcern[], friction: readonly FrictionCluster[]): IntakeAction[] {
  const residual = concerns.some((c) => c.class === "residual");
  if (report.status === "unknown" || report.status === "NEEDS_CONTEXT") return ["enqueue-for-seat"];
  if (report.status === "BLOCKED") {
    return !residual && friction.length > 0 && friction.every((f) => RETRYABLE.has(f)) ? ["count-friction", "resume-after-backoff"] : ["enqueue-for-seat"];
  }
  if (residual) return ["enqueue-for-seat"];
  if (hasPr(report)) return ["verify-head", "ensure-shepherd", "note-task", "retire", "park-tree"];
  return [...(report.plan === undefined ? [] : (["copy-plan"] as const)), "note-task", "retire"];
}

export function intakeRow(record: WorkerReportRecord): IntakeRow {
  const report = parseReport(record.body);
  const concerns = extractConcerns(record.body).map((line) => ({ class: concernClass(line.text), text: line.text }));
  const friction = extractFriction(record.body).map(lineCluster);
  return {
    eventId: record.eventId,
    at: record.at,
    agent: record.agent,
    coordinator: record.coordinator,
    status: report.status,
    pr: report.pr ?? null,
    head: report.head ?? null,
    ci: report.ci?.state ?? null,
    concerns,
    friction,
    actions: suggestActions(report, concerns, friction),
  };
}
