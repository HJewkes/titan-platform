import { MOTION, useBeatTime } from "@titan-design/react-ui/motion";
import { enter, progressAt } from "./stage/entrance.js";

/**
 * Port of the daily spike's GraphBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. Every point is highlighted on
 * its own cue and none recolours its bar, since the fill gives no tone. The spike's stagger was uncapped; react-ui's
 * caps the cascade, so the grow delay is written out.
 */

interface GraphPoint {
  /** The slot element id, set on the point's value as `data-reveal`. */
  id: string;
  label: string;
  value: number;
  /** Beat-local seconds the point's value lights. */
  litAtS: number;
}

const GRAPH_PLOT_PX = 420;
const GROW_EACH_S = 0.13;
const GROW_S = 0.6;

/** Beat-local seconds bar `index` starts growing. */
export const graphGrowStart = (growAtS: number, index: number): number => growAtS + index * GROW_EACH_S;

/** Bar height in px at beat-local `t`; the tallest value fills the plot. */
function barHeight(t: number, index: number, value: number, max: number, growAtS: number): number {
  const p = progressAt(t, graphGrowStart(growAtS, index), GROW_S);
  return max > 0 ? (value / max) * GRAPH_PLOT_PX * p : 0;
}

function GraphBar({ point, height, lit }: { point: GraphPoint; height: number; lit: number }) {
  return (
    <div className="beat-graph-col">
      <span className="beat-graph-value" data-reveal={point.id} style={{ opacity: lit }}>{point.value}</span>
      <div className="beat-graph-bar" style={{ height }} />
    </div>
  );
}

interface GraphFrameProps {
  title?: string;
  unit?: string;
  points: readonly GraphPoint[];
  /** Beat-local seconds the first bar starts growing. */
  growAtS: number;
}

/** A series by day: bars grow left to right from `growAtS`, and each point's value lights at its `litAtS`. */
export function GraphFrame({ title, unit, points, growAtS }: GraphFrameProps) {
  const { t } = useBeatTime();
  const max = Math.max(0, ...points.map((point) => point.value));
  return (
    <>
      {title && <h2 className="beat-heading" style={enter(t, 0)}>{unit ? `${title} (${unit})` : title}</h2>}
      <div className="beat-graph-plot" style={{ height: GRAPH_PLOT_PX + 64 }}>
        {points.map((point, i) => (
          <GraphBar key={point.id} point={point} height={barHeight(t, i, point.value, max, growAtS)} lit={progressAt(t, point.litAtS, MOTION.duration.slow)} />
        ))}
      </div>
      <div className="beat-graph-labels">
        {points.map((point) => <span key={point.id}>{point.label}</span>)}
      </div>
    </>
  );
}
