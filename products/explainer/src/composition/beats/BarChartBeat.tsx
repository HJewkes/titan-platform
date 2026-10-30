import { useBeatTime } from "@titan-design/react-ui/motion";
import { AxisOrigin, axisShare, type AxisFrame } from "./chart-frame.js";
import { litBox, useLit } from "./stage/emphasis.js";
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
  /** The row's own cue: it grows then, never before its place in the cascade from `growAtS`. */
  atS?: number;
}

const GROW_EACH_S = 0.12;
const GROW_S = 0.6;
/** Past this many rows the 64 px row and 14 px gap run taller than the stage box, so rows pack tighter. */
const DENSE_AFTER_ROWS = 9;

const growStart = (row: BarRow, growAtS: number, index: number): number => Math.max(row.atS ?? growAtS, growAtS + index * GROW_EACH_S);

/** The axis every row shares, caps included: from the frame's floor up to the largest value or cap. */
interface BarAxis {
  floor: number;
  max: number;
}

/** Share of the track a row fills at beat-local `t`, growing from `start`. */
function barShare(t: number, start: number, value: number, axis: BarAxis): number {
  return axisShare(value, axis.floor, axis.max) * progressAt(t, start, GROW_S);
}

function Bar({ row, i, t, axis, growAtS }: { row: BarRow; i: number; t: number; axis: BarAxis; growAtS: number }) {
  const start = growStart(row, growAtS, i);
  const shown = progressAt(t, start + GROW_S * 0.6, 0.3);
  const lit = useLit()(row.id, t);
  return (
    <li className="ex-bar-row" data-tone="neutral" data-reveal={row.id} style={{ ...fadeUp(t, start, 16), ...litBox(lit) }}>
      <span className="ex-bar-label">{row.label}</span>
      <span className="ex-bar-track" data-qa-container="">
        <span className="ex-bar-fill" style={{ width: `${barShare(t, start, row.value, axis) * 100}%`, ...(row.colour === undefined ? {} : { background: row.colour }) }} />
        {row.cap !== undefined && <span className="ex-bar-cap" data-qa-decor="" style={{ left: `${axisShare(row.cap, axis.floor, axis.max) * 100}%` }} />}
      </span>
      <span className="ex-bar-value" style={{ opacity: shown }}>{row.cap === undefined ? row.value.toLocaleString("en-US") : `${row.value} / ${row.cap}`}</span>
    </li>
  );
}

const NO_FRAME: AxisFrame = { floor: 0, axisBreak: false };

/**
 * Horizontal bars on one scale, growing top to bottom from `growAtS`, a row lit when a later cue names it; a capped row shows its cap as a marker. The scale
 * starts at the frame's floor, which the frame names when it is not zero.
 */
export function BarChartFrame({ rows, growAtS, frame = NO_FRAME }: { rows: readonly BarRow[]; growAtS: number; frame?: AxisFrame }) {
  const { t } = useBeatTime();
  const axis = { floor: frame.floor, max: Math.max(frame.floor, ...rows.map((r) => Math.max(r.value, r.cap ?? 0))) };
  return (
    <>
      <ul className="ex-bars" data-dense={rows.length > DENSE_AFTER_ROWS || undefined}>
        {rows.map((row, i) => <Bar key={row.id} row={row} i={i} t={t} axis={axis} growAtS={growAtS} />)}
      </ul>
      <AxisOrigin {...frame} />
    </>
  );
}
