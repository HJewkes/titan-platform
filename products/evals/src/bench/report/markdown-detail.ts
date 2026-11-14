import { DASH, num, pct, rate, table, usd } from "./format.js";
import type { JudgeSummary } from "./judgments.js";
import type { implementTrack } from "./track-i.js";
import type { planTrack } from "./track-p.js";
import type { reviewTrack } from "./track-r.js";

function judgeLine(judge: JudgeSummary): string {
  if (judge.items === 0) return "### Judge\n\nNo judgments in this run.";
  const agreement = `kappa ${num(judge.agreement.kappa)}, raw ${pct(judge.agreement.raw)} (n ${judge.agreement.n})`;
  return `### Judge\n\nModels ${judge.models.join(", ")}; ${judge.judged}/${judge.items} items decided; ${judge.voidBatches}/${judge.batches} batches void; second-judge ${agreement}; overhead ${usd(judge.costUsd)}.`;
}

export function reviewDetail(extra: ReturnType<typeof reviewTrack>["extra"]): string {
  const rows = Object.entries(extra.contract).map(([arm, cell]) => [arm, rate(cell)]);
  return ["### Contract failures", "", table(["arm", "contract-failure rate [95% CI]"], rows), "", judgeLine(extra.judge)].join("\n");
}

export function implementDetail(extra: ReturnType<typeof implementTrack>["extra"]): string {
  const rows = Object.entries(extra.perArm).map(([arm, d]) => [arm, num(d.diffLogRatioMedian), `${d.diffOutsideBand.outside}/${d.diffOutsideBand.n}`, String(d.contaminated), String(d.timeout)]);
  return ["### Diff size and voided jobs", "", table(["arm", "median log2(arm/accepted)", "outside [-1, 1]", "contaminated", "timeout"], rows)].join("\n");
}

export function planDetail(extra: ReturnType<typeof planTrack>["extra"]): string {
  const rows = Object.entries(extra.perArm).map(([arm, d]) => [
    arm,
    `${d.wins}/${d.ties}/${d.losses}`,
    Object.entries(d.sliceError)
      .map(([pool, e]) => `${pool}: ${num(e.meanSigned)} / ${num(e.meanAbsolute)} (n ${e.n})`)
      .join("; ") || DASH,
    pct(d.fileRecallMean),
    d.judges.join(", ") || DASH,
  ]);
  const header = ["arm", "win/tie/loss", "slice error signed / absolute by pool", "mean file recall", "judge"];
  return ["### Slices, recall and judges", "", table(header, rows), "", judgeLine(extra.judge)].join("\n");
}
