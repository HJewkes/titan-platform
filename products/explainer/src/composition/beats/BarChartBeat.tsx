import { useBeatTime } from "@titan-design/react-ui/motion";
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
}

const GROW_EACH_S = 0.12;
const GROW_S = 0.6;

const growStart = (growAtS: number, index: number): number => growAtS + index * GROW_EACH_S;

/** Share of the track a row fills at beat-local `t`; every row shares one scale, caps included. */
function barShare(t: number, index: number, value: number, max: number, growAtS: number): number {
  const p = progressAt(t, growStart(growAtS, index), GROW_S);
  return max > 0 ? (value / max) * p : 0;
}

function Bar({ row, i, t, max, growAtS }: { row: BarRow; i: number; t: number; max: number; growAtS: number }) {
  const start = growStart(growAtS, i);
  const shown = progressAt(t, start + GROW_S * 0.6, 0.3);
  return (
    <li className="ex-bar-row" data-tone="neutral" data-reveal={row.id} style={fadeUp(t, start, 16)}>
      <span className="ex-bar-label">{row.label}</span>
      <span className="ex-bar-track" data-qa-container="">
        <span className="ex-bar-fill" style={{ width: `${barShare(t, i, row.value, max, growAtS) * 100}%` }} />
        {row.cap !== undefined && <span className="ex-bar-cap" data-qa-decor="" style={{ left: `${(row.cap / max) * 100}%` }} />}
      </span>
      <span className="ex-bar-value" style={{ opacity: shown }}>{row.cap === undefined ? row.value.toLocaleString("en-US") : `${row.value} / ${row.cap}`}</span>
    </li>
  );
}

/** Horizontal bars on one scale, growing top to bottom from `growAtS`; a capped row shows its cap as a marker. */
export function BarChartFrame({ rows, growAtS }: { rows: readonly BarRow[]; growAtS: number }) {
  const { t } = useBeatTime();
  const max = Math.max(0, ...rows.map((r) => Math.max(r.value, r.cap ?? 0)));
  return (
    <ul className="ex-bars">
      {rows.map((row, i) => <Bar key={row.id} row={row} i={i} t={t} max={max} growAtS={growAtS} />)}
    </ul>
  );
}
