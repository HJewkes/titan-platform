import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";

/**
 * How a chart's axis and colour are drawn from the slots' baseline, axisBreak, scale and legend (TP-4332's fields).
 * The chart-integrity gate decides which of these a pin may ask for; this file only draws what passed it.
 */

type ChartScale = NonNullable<z.infer<(typeof BEAT_SLOTS)["chart"]>["scale"]>;

/** The axis origin a frame draws from: where its value axis starts and whether that axis is drawn broken. */
export interface AxisFrame {
  floor: number;
  axisBreak: boolean;
}

export const axisFrame = (slots: { baseline?: number; axisBreak?: boolean }): AxisFrame => ({ floor: slots.baseline ?? 0, axisBreak: slots.axisBreak ?? false });

/** Share of the axis a value fills when the axis runs from `floor` to `max`; a value at or below the floor fills none. */
export function axisShare(value: number, floor: number, max: number): number {
  if (max <= floor) return 0;
  return Math.min(1, Math.max(0, (value - floor) / (max - floor)));
}

const sequentialPosition = (values: readonly number[]) => {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return (value: number) => (hi > lo ? (value - lo) / (hi - lo) : 0.5);
};

const divergingPosition = (values: readonly number[], centre: number) => {
  const reach = Math.max(...values.map((value) => Math.abs(value - centre)));
  return (value: number) => (reach > 0 ? 0.5 + (value - centre) / (2 * reach) : 0.5);
};

/**
 * Each value's colour on the scale. A sequential ramp spans the values low to high. A diverging one puts its middle
 * colour on `centre`, so values equally far either side of it get colours equally far from the middle.
 */
export function scaleColours(scale: ChartScale, values: readonly number[], centre: number): string[] {
  const position = scale.kind === "sequential" ? sequentialPosition(values) : divergingPosition(values, centre);
  const last = scale.colours.length - 1;
  return values.map((value) => scale.colours[Math.round(position(value) * last)]!);
}

/** Where the value axis starts when it does not start at zero, and the break mark when it is drawn broken. */
export function AxisOrigin({ floor, axisBreak }: AxisFrame) {
  if (floor === 0 && !axisBreak) return null;
  return (
    <span className="ex-axis-origin" data-axis-floor={floor}>
      {axisBreak && <span className="ex-axis-break" data-qa-decor="" aria-label="axis break" />}
      <span className="ex-axis-floor">{floor.toLocaleString("en-US")}</span>
    </span>
  );
}

interface LegendEntry {
  id: string;
  label: string;
  colour?: string;
}

/** A key naming each series beside its colour, for a chart whose series are too many to label directly. */
export function ChartLegend({ entries }: { entries: readonly LegendEntry[] }) {
  return (
    <ul className="ex-chart-legend">
      {entries.map((entry) => (
        <li key={entry.id} className="ex-chart-legend-entry">
          <span className="ex-chart-legend-swatch" style={entry.colour === undefined ? {} : { background: entry.colour }} />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
