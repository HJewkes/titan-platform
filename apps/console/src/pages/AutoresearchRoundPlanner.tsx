import type { ReactNode } from "react";
import { DataRow } from "@titan-design/react-ui";
import type { ArPlanner, ArRound } from "../../server/autoresearch-view.js";
import { modeText } from "./AutoresearchIdeaRecord.js";
import { formatCost, formatTokens } from "./SessionFormat.js";

/**
 * TP-3954 (C-256 S3e): the agent that planned the round, whether it spawned or resumed, and what its turn cost, worded as
 * the idea drawer words an implementer. A string value, so DataRow wraps it on a phone.
 */
export function AutoresearchRoundPlanner({ round }: { round: ArRound }): ReactNode {
  const { planner } = round;
  return <DataRow label="Planner" value={planner === undefined ? "not recorded for this round" : plannerText(planner)} testID={`autoresearch-planner-${round.round}`} />;
}

function plannerText(planner: ArPlanner): string {
  const mode = planner.mode === undefined ? [] : [modeText({ mode: planner.mode })];
  return [planner.agent, ...mode, planner.usage === undefined ? "spend not recorded" : usageText(planner.usage)].join(" · ");
}

function usageText({ usd, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, retries }: NonNullable<ArPlanner["usage"]>): string {
  const written = cacheWrite5mTokens === undefined && cacheWrite1hTokens === undefined ? undefined : (cacheWrite5mTokens ?? 0) + (cacheWrite1hTokens ?? 0);
  return [
    formatCost(usd),
    cacheReadTokens === undefined ? undefined : `${formatTokens(cacheReadTokens)} cache read`,
    written === undefined ? undefined : `${formatTokens(written)} cache write`,
    retries === 1 ? "1 retry" : `${retries} retries`,
  ]
    .filter(Boolean)
    .join(" · ");
}
