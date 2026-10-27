import type { ReactElement } from "react";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { BarChartFrame } from "./BarChartBeat.js";
import { GraphFrame, graphGrowStart } from "./GraphBeat.js";
import type { Reveal } from "./stage/reveal.js";

type ChartSlots = z.infer<(typeof BEAT_SLOTS)["chart"]>;
type ChartView = (props: { slots: ChartSlots; reveal: Reveal }) => ReactElement;

/** A chart with no cue grows a little after the beat opens, as the spike's adapters let it. */
const GROW_DEFAULT_S = 0.3;

const growAt = (slots: ChartSlots, reveal: Reveal): number => reveal(slots.series[0]!.id) ?? GROW_DEFAULT_S;

/** bar: one row a point, all growing from the first bar's cue; a chart cap marks every row. */
function BarChart({ slots, reveal }: { slots: ChartSlots; reveal: Reveal }) {
  const rows = slots.series.map((point) => ({ id: point.id, label: point.label, value: point.value, ...(slots.cap === undefined ? {} : { cap: slots.cap }) }));
  return <BarChartFrame rows={rows} growAtS={growAt(slots, reveal)} />;
}

/** line: a bar a day, each point's value lighting on its own cue, never before its bar starts to grow. */
function LineChart({ slots, reveal }: { slots: ChartSlots; reveal: Reveal }) {
  const growAtS = growAt(slots, reveal);
  const points = slots.series.map((point, i) => ({ ...point, litAtS: Math.max(reveal(point.id) ?? growAtS, graphGrowStart(growAtS, i)) }));
  return <GraphFrame {...(slots.title === undefined ? {} : { title: slots.title })} {...(slots.unit === undefined ? {} : { unit: slots.unit })} points={points} growAtS={growAtS} />;
}

const VIEWS: Partial<Record<ChartSlots["kind"], ChartView>> = { bar: BarChart, line: LineChart };

/** chart: drawn by its kind; a kind with no view (spark, gauge) fails the page rather than drawing something else. */
export function ChartKindBeat({ slots, reveal }: BeatViewProps<ChartSlots>) {
  const View = VIEWS[slots.kind];
  if (!View) throw new Error(`chart kind "${slots.kind}" is not drawn yet; drawn kinds: ${Object.keys(VIEWS).join(", ")}`);
  return <View slots={slots} reveal={reveal} />;
}
