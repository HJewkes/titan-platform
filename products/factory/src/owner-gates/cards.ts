import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import type { FlaggedClass } from "./report.js";

const DEMOTION_ASKER = "titan-factory-owner-gates";

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;

/** The card states only an audit that ran: without one, the owner is told nothing has checked how these approvals turned out. */
const auditLine = (flag: FlaggedClass): string =>
  flag.audited
    ? "The audit sample found no revert, red main or incident in it."
    : "No audit result was consulted for this report, so nothing has checked whether these approvals led to a revert, red main or incident.";

/**
 * The two-way card asking whether a rubber-stamped class should leave the owner. Its deposit id is the week and class, so
 * a re-run of the same week files the card once.
 */
export function demotionDeposit(flag: FlaggedClass, week: string): OwnerItemDeposit {
  return {
    depositId: `owner-gates-${week}-${flag.class}`,
    asker: DEMOTION_ASKER,
    kind: "decide",
    door: "two-way",
    class: flag.class,
    summary: `${flag.class}: you approved ${flag.approved} of ${flag.answered} (${percent(flag.rate)}); demote it?`,
    context: `The weekly owner-gates report (${week}) flagged ${flag.class} at or above 95% approve over 20 or more owner-answered gates. ${auditLine(flag)}`,
    options: [
      { id: "keep", label: "Keep it with the owner", consequence: `${flag.class} gates keep waiting on you; next week's report may flag it again.` },
      { id: "demote-a", label: "Demote to a rule", consequence: `A coded rule decides ${flag.class}; you no longer see these gates.` },
      { id: "demote-b", label: "Demote to the reviewer", consequence: `The reviewer's verdict decides ${flag.class}; you see only its escalations.` },
      { id: "demote-c", label: "Demote to the decider", consequence: `The decider answers ${flag.class} from precedent; you can overrule each answer.` },
    ],
    default: "keep",
    onSilence: { action: "wait" },
    command: "$ titan-factory owner-gates report",
  };
}
