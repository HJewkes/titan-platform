import type { ReactElement } from "react";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { BarChartFrame } from "./BarChartBeat.js";
import { axisFrame, ChartLegend, scaleColours } from "./chart-frame.js";
import { GraphFrame, graphGrowStart } from "./GraphBeat.js";
import type { Reveal } from "./stage/reveal.js";

type ChartSlots = z.infer<(typeof BEAT_SLOTS)["chart"]>;
type ChartViewProps = { slots: ChartSlots; reveal: Reveal; colours: readonly (string | undefined)[] };
type ChartView = (props: ChartViewProps) => ReactElement;

/** A chart with no cue grows a little after the beat opens, as the spike's adapters let it. */
const GROW_DEFAULT_S = 0.3;

const growAt = (slots: ChartSlots, reveal: Reveal): number => reveal(slots.series[0]!.id) ?? GROW_DEFAULT_S;

/** Each point's colour on the slots' scale, a diverging one centred on the axis floor; none without a scale. */
function pointColours(slots: ChartSlots): (string | undefined)[] {
  if (!slots.scale) return slots.series.map(() => undefined);
  return scaleColours(slots.scale, slots.series.map((point) => point.value), slots.baseline ?? 0);
}

/** bar: one row a point, all growing from the first bar's cue; a chart cap marks every row. */
function BarChart({ slots, reveal, colours }: ChartViewProps) {
  const rows = slots.series.map((point, i) => ({
    id: point.id,
    label: point.label,
    value: point.value,
    ...(slots.cap === undefined ? {} : { cap: slots.cap }),
    ...(colours[i] === undefined ? {} : { colour: colours[i] }),
  }));
  return <BarChartFrame rows={rows} growAtS={growAt(slots, reveal)} frame={axisFrame(slots)} />;
}

/** line: a bar a day, each point's value lighting on its own cue, never before its bar starts to grow. */
function LineChart({ slots, reveal, colours }: ChartViewProps) {
  const growAtS = growAt(slots, reveal);
  const points = slots.series.map((point, i) => ({
    ...point,
    litAtS: Math.max(reveal(point.id) ?? growAtS, graphGrowStart(growAtS, i)),
    ...(colours[i] === undefined ? {} : { colour: colours[i] }),
  }));
  const heading = { ...(slots.title === undefined ? {} : { title: slots.title }), ...(slots.unit === undefined ? {} : { unit: slots.unit }) };
  return <GraphFrame {...heading} points={points} growAtS={growAtS} frame={axisFrame(slots)} />;
}

const VIEWS: Partial<Record<ChartSlots["kind"], ChartView>> = { bar: BarChart, line: LineChart };

/** chart: drawn by its kind; a kind with no view (spark, gauge) fails the page rather than drawing something else. */
export function ChartKindBeat({ slots, reveal }: BeatViewProps<ChartSlots>) {
  const View = VIEWS[slots.kind];
  if (!View) throw new Error(`chart kind "${slots.kind}" is not drawn yet; drawn kinds: ${Object.keys(VIEWS).join(", ")}`);
  const colours = pointColours(slots);
  const legend = slots.series.map((point, i) => ({ id: point.id, label: point.label, ...(colours[i] === undefined ? {} : { colour: colours[i] }) }));
  return (
    <>
      <View slots={slots} reveal={reveal} colours={colours} />
      {slots.legend && <ChartLegend entries={legend} />}
    </>
  );
}
