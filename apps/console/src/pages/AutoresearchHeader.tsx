import type { ReactNode } from "react";
import {
  Badge,
  BadgeText,
  DateTime,
  Section,
  SectionContent,
  SectionHeader,
  StatCard,
  StatCardFigure,
  StatCardHeader,
  Typography,
} from "@titan-design/react-ui";
import type { ArAgainst, ArRunSummary, ArRunView } from "../../server/autoresearch-view.js";
import { ladders, shortSha, signed } from "./autoresearch-format.js";
import { noiseText } from "./autoresearch-progress.js";
import { formatCost } from "./SessionFormat.js";

/**
 * Design §1.1: identity and status in the section header, then progress, best, noise, decisions, lanes, spend and the
 * pin as one react-ui StatCard each: the lead figure is the number, the caption the context it is read against.
 * Caps and load wait wait on engine fields (G4, G9).
 */
export function AutoresearchHeader({ run }: { run: ArRunView }): ReactNode {
  const best = bestParts(run);
  const noise = noiseParts(run);
  const decisions = decisionCounts(run);
  return (
    <Section testID="autoresearch-header">
      <SectionHeader title={`${run.target.name} · ${run.runId}`} subtitle={`Phase ${run.target.phases[0]}`} trailing={<RunStatusBadge status={run.status} />} />
      <SectionContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat id="round" label="Round" figure={roundText(run)} caption={<RoundCaption run={run} />} />
          <Stat id="best" label={`Best ${run.target.metric.primary}`} figure={best.figure} caption={best.caption} />
          <Stat id="noise" label="Noise" figure={noise.figure} caption={noise.caption} />
          <Stat id="decisions" label="Decisions" figure={`kept ${decisions.kept}`} caption={`rejected ${decisions.rejected} · stopped ${decisions.stopped} · superseded ${decisions.superseded}`} />
          <Stat id="lanes" label="Lanes in use" figure={`${liveLadders(run)} / ${run.settings.lanes}`} />
          <Stat id="spend" label="Spend" figure={formatCost(spendUsd(run))} />
          <Stat id="pin" label="Pin" figure={shortSha(run.target.pin)} caption={`Ratchet ${run.target.ratchetRef} at ${shortSha(run.best.head)}`} />
        </div>
      </SectionContent>
    </Section>
  );
}

function Stat({ id, label, figure, caption }: { id: string; label: string; figure: string; caption?: ReactNode }): ReactNode {
  return (
    <StatCard
      testID={`autoresearch-stat-${id}`}
      inset="md"
      captionPlacement="below"
      header={<StatCardHeader title={label} />}
      figure={<StatCardFigure value={figure} />}
      caption={
        caption === undefined ? undefined : (
          <Typography variant="body2" color="secondary">
            {caption}
          </Typography>
        )
      }
    />
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

/** C-256 S4c: an ended run names why, in the engine's own code. */
function RoundCaption({ run }: { run: ArRunView }): ReactNode {
  return (
    <>
      Started <DateTime value={run.startedAt} format="datetime" />
      {run.stopReason === undefined ? null : ` · ended: ${run.stopReason}`}
    </>
  );
}

const roundText =(run: ArRunView): string => `${run.rounds.at(-1)?.round ?? 0} / ${run.settings.rounds}`;

const liveLadders = (run: ArRunView): number => ladders(run).filter((ladder) => ladder.active !== null).length;

/** The σ each outcome is stamped with; the newest is the one the next decision is judged by. */
const latestSigma = (run: ArRunView): number | undefined => ladders(run).flatMap((ladder) => (ladder.outcome?.sigma === undefined ? [] : [ladder.outcome.sigma])).at(-1);

/** Δ is signed so that positive is better, whichever way the target's metric points. */
interface StatParts {
  figure: string;
  caption: string;
}

function bestParts(run: ArRunView): StatParts {
  const { direction } = run.target.metric;
  const gain = direction === "min" ? run.baseline.b0 - run.best.primary : run.best.primary - run.baseline.b0;
  const sigma = latestSigma(run);
  const inSigma = sigma === undefined || sigma === 0 ? "" : `, ${signed(gain / sigma)}σ`;
  return { figure: String(run.best.primary), caption: `${signed(gain)} vs B₀ ${run.baseline.b0}${inSigma}` };
}

/** Design G7: the newest decision's noise snapshot; absent on a run recorded before the engine kept one. */
const latestAgainst = (run: ArRunView): ArAgainst | undefined => ladders(run).flatMap((ladder) => (ladder.outcome?.against === undefined ? [] : [ladder.outcome.against])).at(-1);

/** A run without the snapshot shows the stamped σ, but with no pair count its band is the default, the progress chart's rule, so the two never disagree. */
function noiseParts(run: ArRunView): StatParts {
  const against = latestAgainst(run);
  const sigma = against?.sigma ?? latestSigma(run);
  const { noise } = run.target.metric;
  if (sigma === undefined) return { figure: "σ not measured yet", caption: `band ±${noise.defaultBandPp}pp` };
  return { figure: `σ ${sigma}`, caption: noiseText(noise, against ?? { sigma }) };
}

/** A superseded winner counts apart from the other stops: it is back in the queue, not a loss. */
function decisionCounts(run: ArRunView): { kept: number; rejected: number; stopped: number; superseded: number } {
  const outcomes = ladders(run).flatMap((ladder) => (ladder.outcome ? [ladder.outcome] : []));
  const count = (test: (outcome: (typeof outcomes)[number]) => boolean) => outcomes.filter(test).length;
  const superseded = count((outcome) => outcome.reason === "superseded");
  const stopped = count((outcome) => outcome.verdict === "stopped") - superseded;
  return { kept: count((outcome) => outcome.verdict === "kept"), rejected: count((outcome) => outcome.verdict === "rejected"), stopped, superseded };
}

function spendUsd(run: ArRunView): number {
  const evals = [...run.baseline.runs, ...ladders(run).flatMap((ladder) => ladder.evals)];
  const implement = ladders(run).reduce((sum, ladder) => sum + (ladder.implementUsd ?? 0), 0);
  return evals.reduce((sum, entry) => sum + entry.usd, implement);
}
