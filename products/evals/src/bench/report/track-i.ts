import type { RunData } from "./load.js";
import { quantile } from "./stats.js";
import { armCells, type TableSpec, type TrackContext } from "./tables.js";
import { assembleTrack, flag, numberField, trackContext } from "./track.js";

/** log2(arm / accepted) beyond this magnitude means the arm's diff is over 2x smaller or larger than what merged. */
const DIFF_RATIO_BAND = 1;

export const implementSolved = flag("solved");

const SPEC: TableSpec = {
  id: "implement",
  title: "Implement",
  primaryLabel: "solved (hidden tests and own suite)",
  include: () => true,
  primary: implementSolved,
  secondary: { hiddenPass: flag("hiddenPass"), ownPass: flag("ownPass"), typecheck: flag("typecheck") },
  strataKeys: ["kind", "size"],
};

interface DiffAndVoids {
  diffLogRatioMedian: number | null;
  diffOutsideBand: { outside: number; n: number };
  contaminated: number;
  timeout: number;
}

function diffAndVoids(run: RunData, ctx: TrackContext, arm: string): DiffAndVoids {
  const ratios = armCells(ctx, arm).flatMap((cell) => {
    const ratio = numberField(cell, "diffLogRatio");
    return ratio === null ? [] : [ratio];
  });
  const all = run.cells.filter((cell) => cell.arm === arm);
  return {
    diffLogRatioMedian: quantile(ratios, 0.5),
    diffOutsideBand: { outside: ratios.filter((ratio) => Math.abs(ratio) > DIFF_RATIO_BAND).length, n: ratios.length },
    contaminated: all.filter((cell) => cell.outcome === "contaminated").length,
    timeout: all.filter((cell) => cell.outcome === "timeout").length,
  };
}

export function implementTrack(run: RunData) {
  const ctx = trackContext(run);
  const perArm = Object.fromEntries(ctx.arms.map((arm) => [arm, diffAndVoids(run, ctx, arm)]));
  return assembleTrack(run, ctx, { specs: [SPEC], success: implementSolved, successLabel: "solved", judgeUsd: 0, extra: { perArm } });
}
