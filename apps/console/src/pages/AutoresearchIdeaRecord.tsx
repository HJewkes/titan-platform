import type { ReactNode } from "react";
import { DataRow, HStack, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { ArL0Check, ArLadder, ArRunView } from "../../server/autoresearch-view.js";
import { shortSha } from "./autoresearch-format.js";
import { noiseText } from "./autoresearch-progress.js";
import { formatCost } from "./SessionFormat.js";

const NOT_RECORDED = "not recorded for this idea";

/**
 * Design §2.2 with gaps G2, G3, G4, G6 and G7 filled: how the implementer ran, the lane and fork, the noise the idea was
 * judged against, each L0 check and where the dollars went. A run recorded before the engine kept these says so per row.
 */
export function AutoresearchIdeaRecord({ run, ladder }: { run: ArRunView; ladder: ArLadder }): ReactNode {
  const { implementer, outcome } = ladder;
  return (
    <VStack gap={1} testID="autoresearch-drawer-record">
      <DataRow label="Implementer mode" value={implementer?.mode === undefined ? NOT_RECORDED : modeText(implementer)} testID="autoresearch-drawer-mode" />
      <DataRow label="Lane" value={<LaneFork ladder={ladder} />} testID="autoresearch-drawer-lane" />
      <DataRow label="Judged against" value={againstText(run, ladder)} testID="autoresearch-drawer-against" />
      <DataRow label="L0 checks" value={<L0Checks ladder={ladder} />} testID="autoresearch-drawer-l0" />
      <DataRow label="Spend" value={outcome?.usage === undefined ? NOT_RECORDED : usageText(outcome.usage)} testID="autoresearch-drawer-usage" />
    </VStack>
  );
}

export const modeText = ({ mode, account }: { mode?: "spawn" | "resume"; account?: string }): string =>
  [mode === "resume" ? "resumed" : "spawned fresh", account === undefined ? undefined : `account ${account}`].filter(Boolean).join(" · ");

/** Design §1.3's lane pills: an exploit lane warm-resumes a winner's implementer, an explore lane starts fresh. */
function LaneFork({ ladder }: { ladder: ArLadder }): ReactNode {
  const { lane, fork } = ladder.outcome ?? {};
  if (lane === undefined && fork === undefined) return NOT_RECORDED;
  return (
    <HStack gap={2} align="center" wrap>
      {lane === undefined ? null : <Typography variant="body2">{`lane ${lane}`}</Typography>}
      {fork === undefined ? null : (
        <Pill variant="subtle" size="xs" tone={fork === "exploit" ? "brand" : "neutral"}>
          {fork === "exploit" ? "exploit · warm" : "explore · fresh"}
        </Pill>
      )}
    </HStack>
  );
}

function againstText(run: ArRunView, ladder: ArLadder): string {
  const against = ladder.outcome?.against;
  if (against === undefined) return NOT_RECORDED;
  const base = against.head === undefined ? [] : [`B at ${shortSha(against.head)}`];
  return [`σ ${against.sigma}`, noiseText(run.target.metric.noise, against), ...base].join(" · ");
}

/** Each check's row once the engine records them; before that only L0's own pass or fail code. */
function L0Checks({ ladder }: { ladder: ArLadder }): ReactNode {
  const { l0 } = ladder;
  if (l0 === null) return "L0 has not run yet";
  if (l0.checks === undefined || l0.checks.length === 0) return l0.ok ? "passed (no per-check rows recorded)" : `failed: ${l0.code ?? "no code"} (no per-check rows recorded)`;
  return (
    <VStack gap={0}>
      {l0.checks.map((check) => (
        <Typography key={check.name} variant="body2" testID={`autoresearch-l0-check-${check.name}`}>
          {checkText(check)}
        </Typography>
      ))}
    </VStack>
  );
}

const checkText = ({ name, ok, code, ms }: ArL0Check): string => `${ok ? "✓" : "✗"} ${name}${code === undefined ? "" : ` · ${code}`}${ms === undefined ? "" : ` · ${(ms / 1000).toFixed(1)}s`}`;

const usageText = ({ implementUsd, evalUsd, microUsd }: NonNullable<NonNullable<ArLadder["outcome"]>["usage"]>): string =>
  `implement ${formatCost(implementUsd)} · eval ${formatCost(evalUsd)} · micro ${formatCost(microUsd)}`;
