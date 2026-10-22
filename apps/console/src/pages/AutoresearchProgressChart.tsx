import type { ReactNode } from "react";
import { Caption, Scatter, VStack, resolveColor, useMeasuredWidth, type ScatterDatum } from "@titan-design/react-ui";
import type { ProgressPoint, ProgressSample, RunProgress } from "./autoresearch-progress.js";
import { shortId } from "./autoresearch-format.js";

/**
 * The §1.5 chart, drawn with react-ui's Scatter until TD-1000 exports LineChart with a band. Only this file knows that: the
 * best-so-far step line and both band edges are dense dot runs, and the lock rule and the L0/L1 ticks are dots too. Swap
 * this file for LineChart and nothing else changes.
 */

export type ProgressAxis = "time" | "ideas";

interface ChartProps {
  progress: RunProgress;
  axis: ProgressAxis;
  primary: string;
  direction: "min" | "max";
}

const FALLBACK_WIDTH = 320;
const CHART_HEIGHT = 240;
const SPEND_HEIGHT = 120;
const DOT_SPACING_PX = 5;
const MS_PER_MINUTE = 60_000;
const LINE_R = 1.5;
const BAND_R = 1;
const POINT_R = 5;
const KEPT_R = 7;
const TICK_R = 2.5;

/** Series take semantic roles: the line is the first categorical hue, verdicts read as status, a stop is grey. */
const LINE_COLOR = resolveColor("dataviz-categorical-0");
const VERDICT_COLOR: Record<ProgressPoint["verdict"], string> = {
  kept: resolveColor("status-success"),
  rejected: resolveColor("status-error"),
  stopped: resolveColor("text-tertiary"),
};

export function AutoresearchProgressChart({ progress, axis, primary, direction }: ChartProps): ReactNode {
  const { width, onLayout } = useMeasuredWidth();
  const plotWidth = width ?? FALLBACK_WIDTH;
  const xOf = xScale(progress.samples[0]!.at, axis);
  const line = lineDots(progress.samples, xOf, plotWidth);
  const yDomain = yBounds(line, progress.points);
  const data = [...line, ...pointDots(progress.points, xOf, yDomain.yMin), ...lockDots(progress, xOf, yDomain)];
  const xLabel = axis === "time" ? "minutes since start" : "ideas evaluated";
  return (
    <VStack gap={1} onLayout={onLayout} testID="autoresearch-progress-chart">
      <Scatter data={data} width={plotWidth} height={CHART_HEIGHT} axis={{ xLabel, yLabel: `${primary} (${direction === "min" ? "lower" : "higher"} is better)`, ...yDomain }} />
      <Caption>Line: best-so-far, moved only by kept ideas. Dots above and below: the σ band. Green kept, red rejected, grey stopped; L0/L1 stops sit on the floor.</Caption>
    </VStack>
  );
}

/** Design §1.5's second panel: cumulative spend against ideas evaluated, so a cheap-looking stretch that burns $ shows. */
export function AutoresearchSpendChart({ points }: { points: readonly ProgressPoint[] }): ReactNode {
  const { width, onLayout } = useMeasuredWidth();
  let total = 0;
  const data: ScatterDatum[] = points.map((point) => {
    total += point.usd;
    return { id: `spend-${point.id}`, x: point.order, y: total, r: TICK_R, color: LINE_COLOR };
  });
  return (
    <VStack onLayout={onLayout} testID="autoresearch-spend-chart">
      <Scatter data={data} width={width ?? FALLBACK_WIDTH} height={SPEND_HEIGHT} axis={{ xLabel: "ideas evaluated", yLabel: "cumulative $", xMin: 0, yMin: 0 }} />
    </VStack>
  );
}

function xScale(startedAt: string, axis: ProgressAxis): (sample: { order: number; at: string }) => number {
  const start = Date.parse(startedAt);
  return axis === "ideas" ? (sample) => sample.order : (sample) => Math.max(0, (Date.parse(sample.at) - start) / MS_PER_MINUTE);
}

/** A step-after line: each sample's best holds until the next sample, then drops straight to the new value. */
function lineDots(samples: readonly ProgressSample[], xOf: (sample: ProgressSample) => number, width: number): ScatterDatum[] {
  const xs = samples.map(xOf);
  const span = Math.max(xs.at(-1)! - xs[0]!, 1);
  const step = (span * DOT_SPACING_PX) / width;
  return samples.flatMap((sample, index) => {
    const next = samples[index + 1];
    const end = next === undefined ? xs[index]! + step : xs[index + 1]!;
    const run = range(xs[index]!, end, step).flatMap((x, dot) => segmentDots(`s${index}-${dot}`, x, sample));
    return next === undefined || next.best === sample.best ? run : [...run, ...riserDots(`r${index}`, end, sample.best, next.best, step)];
  });
}

function segmentDots(id: string, x: number, sample: ProgressSample): ScatterDatum[] {
  const { best, band } = sample;
  return [
    { id: `line-${id}`, x, y: best, r: LINE_R, color: LINE_COLOR },
    { id: `band-hi-${id}`, x, y: best + band.halfWidth, r: BAND_R, color: LINE_COLOR },
    { id: `band-lo-${id}`, x, y: best - band.halfWidth, r: BAND_R, color: LINE_COLOR },
  ];
}

function riserDots(id: string, x: number, from: number, to: number, step: number): ScatterDatum[] {
  const count = Math.max(2, Math.ceil(Math.abs(to - from) / step));
  return Array.from({ length: count }, (_, dot) => ({ id: `line-${id}-${dot}`, x, y: from + ((to - from) * dot) / count, r: LINE_R, color: LINE_COLOR }));
}

function range(from: number, to: number, step: number): number[] {
  const count = Math.max(1, Math.ceil((to - from) / step));
  return Array.from({ length: count }, (_, index) => from + index * step);
}

function pointDots(points: readonly ProgressPoint[], xOf: (point: ProgressPoint) => number, floor: number): ScatterDatum[] {
  return points.map((point) =>
    point.primary === null
      ? { id: `tick-${point.id}`, x: xOf(point), y: floor, r: TICK_R, color: VERDICT_COLOR.stopped }
      : { id: `point-${point.id}`, x: xOf(point), y: point.primary, r: point.verdict === "kept" ? KEPT_R : POINT_R, color: VERDICT_COLOR[point.verdict], label: shortId(point.id) },
  );
}

/** A vertical run of dots where σ locks, standing in for LineChart's labelled reference rule. */
function lockDots(progress: RunProgress, xOf: (sample: ProgressSample) => number, domain: { yMin: number; yMax: number }): ScatterDatum[] {
  const { lockedAt } = progress;
  if (lockedAt === undefined) return [];
  const x = xOf(lockedAt);
  return range(domain.yMin, domain.yMax, (domain.yMax - domain.yMin) / 24).map((y, dot) => ({ id: `lock-${dot}`, x, y, r: BAND_R, color: VERDICT_COLOR.stopped }));
}

function yBounds(line: readonly ScatterDatum[], points: readonly ProgressPoint[]): { yMin: number; yMax: number } {
  const ys = [...line.map((dot) => dot.y), ...points.flatMap((point) => (point.primary === null ? [] : [point.primary]))];
  const [low, high] = [Math.min(...ys), Math.max(...ys)];
  const pad = Math.max((high - low) * 0.1, 0.1);
  return { yMin: low - pad, yMax: high + pad };
}
