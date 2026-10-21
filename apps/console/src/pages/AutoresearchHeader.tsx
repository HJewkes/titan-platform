import type { ReactNode } from "react";
import { Badge, BadgeText, DataRow, DateTime, Section, SectionContent, SectionHeader } from "@titan-design/react-ui";
import type { ArRunSummary, ArRunView } from "../../server/autoresearch-view.js";
import { ladders, shortSha, signed } from "./autoresearch-format.js";
import { formatCost } from "./SessionFormat.js";

/**
 * Design §1.1: identity, status, progress, noise and spend, one DataRow each. The stats live here alone so that react-ui's
 * StatCard can replace the rows in this one file. Caps, σ pairs and load wait wait on engine fields (G4, G7, G9).
 */
export function AutoresearchHeader({ run }: { run: ArRunView }): ReactNode {
  const { primary } = run.target.metric;
  return (
    <Section testID="autoresearch-header">
      <SectionHeader title={`${run.target.name} · ${run.runId}`} subtitle={`Phase ${run.target.phases[0]}`} />
      <SectionContent>
        <DataRow label="Status" value={<RunStatusBadge status={run.status} />} />
        <DataRow label="Started" value={<DateTime value={run.startedAt} format="datetime" />} />
        <DataRow label="Round" value={roundText(run)} />
        <DataRow label={`Best ${primary}`} value={bestText(run)} />
        <DataRow label="Noise" value={noiseText(run)} />
        <DataRow label="Decisions" value={decisionsText(run)} />
        <DataRow label="Lanes in use" value={`${liveLadders(run)} / ${run.settings.lanes}`} />
        <DataRow label="Spend" value={formatCost(spendUsd(run))} />
        <DataRow label="Pin" value={shortSha(run.target.pin)} />
        <DataRow label="Ratchet" value={`${run.target.ratchetRef} at ${shortSha(run.best.head)}`} />
      </SectionContent>
    </Section>
  );
}

export function RunStatusBadge({ status }: { status: ArRunSummary["status"] }): ReactNode {
  const color = status === "running" ? "info" : status === "completed" ? "success" : status === "failed" ? "error" : "warning";
  return (
    <Badge color={color} variant="subtle" size="sm">
      <BadgeText>{status}</BadgeText>
    </Badge>
  );
}

const roundText = (run: ArRunView): string => `${run.rounds.at(-1)?.round ?? 0} / ${run.settings.rounds}`;

const liveLadders = (run: ArRunView): number => ladders(run).filter((ladder) => ladder.active !== null).length;

/** The σ each outcome is stamped with; the newest is the one the next decision is judged by. */
const latestSigma = (run: ArRunView): number | undefined => ladders(run).flatMap((ladder) => (ladder.outcome?.sigma === undefined ? [] : [ladder.outcome.sigma])).at(-1);

/** Δ is signed so that positive is better, whichever way the target's metric points. */
function bestText(run: ArRunView): string {
  const { direction } = run.target.metric;
  const gain = direction === "min" ? run.baseline.b0 - run.best.primary : run.best.primary - run.baseline.b0;
  const sigma = latestSigma(run);
  const inSigma = sigma === undefined || sigma === 0 ? "" : `, ${signed(gain / sigma)}σ`;
  return `${run.best.primary} (${signed(gain)} vs B₀ ${run.baseline.b0}${inSigma})`;
}

function noiseText(run: ArRunView): string {
  const sigma = latestSigma(run);
  const { bandSigmas, defaultBandPp } = run.target.metric.noise;
  return sigma === undefined ? `σ not measured yet · band ±${defaultBandPp}pp` : `σ ${sigma} · band ±${(bandSigmas * sigma).toFixed(2)}`;
}

/** A superseded winner counts apart from the other stops: it is back in the queue, not a loss. */
function decisionsText(run: ArRunView): string {
  const outcomes = ladders(run).flatMap((ladder) => (ladder.outcome ? [ladder.outcome] : []));
  const count = (test: (outcome: (typeof outcomes)[number]) => boolean) => outcomes.filter(test).length;
  const superseded = count((outcome) => outcome.reason === "superseded");
  const stopped = count((outcome) => outcome.verdict === "stopped") - superseded;
  return `kept ${count((outcome) => outcome.verdict === "kept")} · rejected ${count((outcome) => outcome.verdict === "rejected")} · stopped ${stopped} · superseded ${superseded}`;
}

function spendUsd(run: ArRunView): number {
  const evals = [...run.baseline.runs, ...ladders(run).flatMap((ladder) => ladder.evals)];
  const implement = ladders(run).reduce((sum, ladder) => sum + (ladder.implementUsd ?? 0), 0);
  return evals.reduce((sum, entry) => sum + entry.usd, implement);
}
