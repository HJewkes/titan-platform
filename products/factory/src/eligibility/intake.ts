import type { Bet, Outcome, Task } from "@titan-design/pm";

/*
 * The selection rules a dispatcher rule file switches on (TP-5755 PLAN 3, slice S3): intake for agent-filed work, the
 * bet's success statement, `blocked_on`, and the relax list. Pure; every outside fact arrives in the policy.
 */

export const RELAXATIONS = ["bet-field", "no-fold", "no-owner-steps"] as const;

export type Relaxation = (typeof RELAXATIONS)[number];

/** Lowest first, so a position compare is a severity compare. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

type Severity = (typeof SEVERITIES)[number];

export interface SelectionPolicy {
  relax: readonly Relaxation[];
  intake: { minSeverity: Severity; expireDays: number };
  /** Today as `YYYY-MM-DD`, for intake expiry. */
  today: string;
  /** `owner/repo#n` refs whose Shepherd run stopped; "unread" when that read failed. */
  stoppedPrs: ReadonlySet<string> | "unread";
}

export type PolicyCode = "intake-low-severity" | "intake-from-stopped-pr" | "intake-expired" | "serves-other-outcome" | "outcome-retired" | "blocked" | "signal-unreadable";

interface PolicyRefusal {
  code: PolicyCode;
  detail: string;
}

/** Sources an agent files; owner, plan and incident work is not intake. Incidents are reproduced failures and always admitted. */
const AGENT_SOURCES: ReadonlySet<string> = new Set(["follow-up", "review", "sweep", "audit", "coordinator"]);

const DAY_MS = 86_400_000;

const fromPr = (task: Task): string | undefined => (typeof task.source_ref === "object" ? task.source_ref.from_pr : undefined);

function severityRefusal(task: Task, policy: SelectionPolicy): PolicyRefusal[] {
  const floor = SEVERITIES.indexOf(policy.intake.minSeverity);
  if (task.severity !== undefined && SEVERITIES.indexOf(task.severity) >= floor) return [];
  return [{ code: "intake-low-severity", detail: `${task.source} work at severity ${task.severity ?? "unset"}, below ${policy.intake.minSeverity}` }];
}

function stoppedPrRefusal(task: Task, policy: SelectionPolicy): PolicyRefusal[] {
  const pr = fromPr(task);
  if (pr === undefined) return [];
  if (policy.stoppedPrs === "unread") return [{ code: "signal-unreadable", detail: `whether ${pr} stopped could not be read` }];
  return policy.stoppedPrs.has(pr) ? [{ code: "intake-from-stopped-pr", detail: `filed from ${pr}, whose Shepherd run stopped` }] : [];
}

function expiryRefusal(task: Task, bet: Bet | undefined, policy: SelectionPolicy): PolicyRefusal[] {
  if (bet !== undefined) return [];
  const age = (Date.parse(policy.today) - Date.parse(task.created.slice(0, 10))) / DAY_MS;
  return age > policy.intake.expireDays ? [{ code: "intake-expired", detail: `unpromoted for ${Math.floor(age)} days, past ${policy.intake.expireDays}` }] : [];
}

function intakeRefusals(task: Task, bet: Bet | undefined, policy: SelectionPolicy): PolicyRefusal[] {
  if (task.source === undefined || !AGENT_SOURCES.has(task.source)) return [];
  return [...severityRefusal(task, policy), ...stoppedPrRefusal(task, policy), ...expiryRefusal(task, bet, policy)];
}

function outcomeRefusals(task: Task, bet: Bet | undefined, outcomes: readonly Outcome[]): PolicyRefusal[] {
  if (bet === undefined) return [];
  const refusals: PolicyRefusal[] = [];
  if (task.serves !== undefined && task.serves !== bet.outcome) refusals.push({ code: "serves-other-outcome", detail: `serves ${task.serves}, but ${bet.id} serves ${bet.outcome}` });
  if (outcomes.find((outcome) => outcome.id === bet.outcome)?.state === "retired") refusals.push({ code: "outcome-retired", detail: `${bet.outcome} is retired` });
  return refusals;
}

/** Every policy reason the task may not be dispatched under the bet it resolved to (none when it resolved to no bet). */
export function policyRefusals(task: Task, bet: Bet | undefined, outcomes: readonly Outcome[], policy: SelectionPolicy): PolicyRefusal[] {
  const blocked: PolicyRefusal[] = task.blocked_on === undefined ? [] : [{ code: "blocked", detail: `blocked on ${task.blocked_on}` }];
  return [...intakeRefusals(task, bet, policy), ...outcomeRefusals(task, bet, outcomes), ...blocked];
}
