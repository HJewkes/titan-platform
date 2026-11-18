import type { ReactNode } from "react";
import { Typography } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";

type Ready = Extract<ConsoleCommands["inbox.prepare"]["result"], { status: "ready" }>;
/** A planning op's read-back: bets to select, an outcome edit, or a freeze, as active-work's plan store holds them now. */
type PlanReadBack = Extract<Ready["readBack"], { planOp: string }>;
type BetSelect = Extract<PlanReadBack, { planOp: "bet-select" }>;
type OutcomeEdit = Extract<PlanReadBack, { planOp: "outcome-edit" }>;
type FreezeFacts = Extract<PlanReadBack, { planOp: "freeze" }>;
type BetLine = BetSelect["bets"][number];

/** Enough to decide from the phone; the depositing agent's words come last, labelled as theirs. */
export function PlanFacts({ readBack }: { readBack: PlanReadBack }): ReactNode {
  return (
    <>
      {readBack.planOp === "bet-select" ? <BetFacts readBack={readBack} /> : null}
      {readBack.planOp === "outcome-edit" ? <OutcomeEditFacts readBack={readBack} /> : null}
      {readBack.planOp === "freeze" ? <FreezeLines readBack={readBack} /> : null}
      <Typography variant="caption" color="secondary">{`Authority ${readBack.authority}`}</Typography>
      <Typography variant="caption" color="secondary" testID="inbox-readback-proposal">{`Proposed by ${readBack.proposedBy}: ${readBack.proposal}`}</Typography>
    </>
  );
}

const predictionOf = ({ prediction: { metric, direction, baseline, expected, read_by } }: BetLine): string => `${metric}: ${direction} from ${baseline} to ${expected}, read by ${read_by}`;
const tasksOf = (bet: BetLine): string => (bet.tasks.length > 0 ? `Tasks ${bet.tasks.join(", ")}` : `Tasks matching ${bet.selector ?? "?"}`);

function BetFacts({ readBack }: { readBack: BetSelect }): ReactNode {
  return readBack.bets.map((bet) => (
    <div key={bet.id} className="flex flex-col gap-1" data-testid="inbox-readback-bet">
      <Typography variant="body2">{`${bet.id} (rank ${bet.order}${bet.state === "selected" ? ", already selected" : ""}) for ${bet.outcome}`}</Typography>
      {bet.outcomeStatement === null ? null : <Typography variant="caption" color="secondary">{`Outcome: ${bet.outcomeStatement}`}</Typography>}
      <Typography variant="mono">{predictionOf(bet)}</Typography>
      <Typography variant="caption" color="secondary">{tasksOf(bet)}</Typography>
    </div>
  ));
}

function OutcomeEditFacts({ readBack: { before, after } }: { readBack: OutcomeEdit }): ReactNode {
  const fields = (["statement", "measure"] as const).filter((field) => before[field] !== after[field]);
  return fields.map((field) => (
    <div key={field} className="flex flex-col gap-1" data-testid="inbox-readback-outcome-edit">
      <Typography variant="caption" color="secondary">{`${field === "statement" ? "Statement" : "Measure"} now: ${before[field]}`}</Typography>
      <Typography variant="body2">{`Becomes: ${after[field]}`}</Typography>
    </div>
  ));
}

function FreezeLines({ readBack }: { readBack: FreezeFacts }): ReactNode {
  return (
    <>
      <Typography variant="body2">{`Stops ${readBack.stops} in ${readBack.initiative}`}</Typography>
      <Typography variant="caption" color="secondary">{`Why: ${readBack.reason}`}</Typography>
      <Typography variant="caption" color="secondary">{readBack.action === "set" ? `Ends ${readBack.ends}` : `It was set to end ${readBack.ends}; this ends it now`}</Typography>
    </>
  );
}
