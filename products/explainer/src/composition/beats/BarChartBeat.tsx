import { useBeatTime } from "@titan-design/react-ui/motion";
import { AxisOrigin, axisShare, type AxisFrame } from "./chart-frame.js";
import { progressAt } from "./stage/entrance.js";
import { fadeUp } from "./stage/video.js";

/**
 * Port of the daily spike's examples/BarChartBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. The fill gives no
 * tone and no note, so every bar stays neutral and the note stays behind. The spike's stagger was uncapped;
 * react-ui's caps the cascade, so the grow delay is written out.
 */

interface BarRow {
  /** The slot element id, set on the row as `data-reveal`. */
  id: string;
  label: string;
  value: number;
  /** Draws a cap marker on the row and shows the value as `value / cap`. */
  cap?: number;
  /** The fill's colour on the chart's scale; neutral without one. */
  colour?: string;
}

const GROW_EACH_S = 0.12;
const GROW_S = 0.6;

const growStart = (growAtS: number, index: number): number => growAtS + index * GROW_EACH_S;

/** The axis every row shares, caps included: from the frame's floor up to the largest value or cap. */
interface BarAxis {
  floor: number;
  max: number;
}

/** Share of the track a row fills at beat-local `t`. */
function barShare(t: number, index: number, value: number, axis: BarAxis, growAtS: number): number {
  return axisShare(value, axis.floor, axis.max) * progressAt(t, growStart(growAtS, index), GROW_S);
}

function Bar({ row, i, t, axis, growAtS }: { row: BarRow; i: number; t: number; axis: BarAxis; growAtS: number }) {
  const start = growStart(growAtS, i);
  const shown = progressAt(t, start + GROW_S * 0.6, 0.3);
  return (
    <li className="ex-bar-row" data-tone="neutral" data-reveal={row.id} style={fadeUp(t, start, 16)}>
      <span className="ex-bar-label">{row.label}</span>
      <span className="ex-bar-track" data-qa-container="">
        <span className="ex-bar-fill" style={{ width: `${barShare(t, i, row.value, axis, growAtS) * 100}%`, ...(row.colour === undefined ? {} : { background: row.colour }) }} />
        {row.cap !== undefined && <span className="ex-bar-cap" data-qa-decor="" style={{ left: `${axisShare(row.cap, axis.floor, axis.max) * 100}%` }} />}
      </span>
      <span className="ex-bar-value" style={{ opacity: shown }}>{row.cap === undefined ? row.value.toLocaleString("en-US") : `${row.value} / ${row.cap}`}</span>
    </li>
  );
}

const NO_FRAME: AxisFrame = { floor: 0, axisBreak: false };

/**
 * Horizontal bars on one scale, growing top to bottom from `growAtS`; a capped row shows its cap as a marker. The scale
 * starts at the frame's floor, which the frame names when it is not zero.
 */
export function BarChartFrame({ rows, growAtS, frame = NO_FRAME }: { rows: readonly BarRow[]; growAtS: number; frame?: AxisFrame }) {
  const { t } = useBeatTime();
  const axis = { floor: frame.floor, max: Math.max(frame.floor, ...rows.map((r) => Math.max(r.value, r.cap ?? 0))) };
  return (
    <>
      <ul className="ex-bars">
        {rows.map((row, i) => <Bar key={row.id} row={row} i={i} t={t} axis={axis} growAtS={growAtS} />)}
      </ul>
      <AxisOrigin {...frame} />
    </>
  );
}
