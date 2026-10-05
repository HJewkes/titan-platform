import { DEFAULT_TABLE, evaluate } from "@titan-design/authority";
import type { ActorClass, Decision, PolicyTable } from "@titan-design/authority";
import type { ActorObservation } from "./actor.js";
import type { SpellingId } from "./spellings.js";
import type { ClassifiedAction, GuardedAction } from "./types.js";

/** The action, spelling and rule behind a decision; logged on a deny or a bypass. */
export interface Matched {
  ruleId: string | null;
  action: GuardedAction;
  spelling: SpellingId;
  subject: Record<string, string>;
}

/** Pass carries the strictest match when anything was classified, so a bypass can be logged. */
export type GuardDecision = { outcome: "pass"; matched: Matched | null } | ({ outcome: "deny"; reason: string } & Matched);

interface Verdict {
  action: ClassifiedAction;
  actor: ActorClass;
  decision: Decision;
}

const RANK: Record<Decision["verdict"], number> = { allow: 0, gate: 1, deny: 2 };

/**
 * Evaluates every (action, candidate) pair and keeps the strictest verdict: deny beats gate beats
 * allow. A gate denies too, since this hook has no gate door to check (TP-404 adds one).
 */
export function decide(actions: readonly ClassifiedAction[], actor: ActorObservation, table: PolicyTable = DEFAULT_TABLE): GuardDecision {
  const verdicts = actions.flatMap((action) => actor.candidates.map((cls) => verdictFor(table, action, cls, actor.id)));
  const top = strictest(verdicts);
  if (!top) return { outcome: "pass", matched: null };
  const matched = { ruleId: top.decision.ruleId, action: top.action.action, spelling: top.action.spelling, subject: top.action.subject };
  if (top.decision.verdict === "allow") return { outcome: "pass", matched };
  return { outcome: "deny", reason: reasonFor(top, verdicts), ...matched };
}

function verdictFor(table: PolicyTable, action: ClassifiedAction, cls: ActorClass, id: string): Verdict {
  const decision = evaluate(table, { action: action.action, actor: { class: cls, id }, tainted: false, subject: action.subject });
  return { action, actor: cls, decision };
}

function strictest(verdicts: readonly Verdict[]): Verdict | null {
  return verdicts.reduce<Verdict | null>((best, v) => (!best || RANK[v.decision.verdict] > RANK[best.decision.verdict] ? v : best), null);
}

/** One line: what was refused and why, any owner gate it would need, then what to do instead. */
function reasonFor(top: Verdict, verdicts: readonly Verdict[]): string {
  const rule = top.decision.ruleId ?? "no matching rule";
  const head = `authority-guard denied ${top.action.action} (${top.action.spelling}, rule ${rule}).`;
  const gates = [...new Set(verdicts.filter((v) => v.action === top.action && v.decision.verdict === "gate").map((v) => v.decision.ruleId))];
  const gate = gates.length > 0 ? ` It needs an owner-resolved gate (rule ${gates.join(", ")}); none can be checked yet, so ask the owner.` : "";
  return `${head}${gate} ${top.action.remedy}`;
}
