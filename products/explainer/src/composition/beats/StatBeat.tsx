import { spring, useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { progressAt } from "./stage/entrance.js";

/**
 * Port of the daily spike's StatBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. The fill gives figures and no
 * delta chip, so the delta pill stays behind with the figures' delta, interval and grade, which no daily fills.
 */

type Figure = z.infer<(typeof BEAT_SLOTS)["stat"]>["figures"][number];

const COUNT_START_S = 0.2;
const COUNT_SPRING = { stiffness: 120, damping: 18 } as const;
/** A figure with no cue of its own lands this long after the one before it. */
const CARD_EACH_S = 0.25;

/** The value shown `local` seconds after the card lands: a spring from 0 that overshoots slightly and settles. */
function statDisplay(local: number, value: number): string {
  const places = Number.isInteger(value) ? 0 : 1;
  return spring(local - COUNT_START_S, { ...COUNT_SPRING, to: value }).toFixed(places);
}

function StatCard({ figure, t, atS }: { figure: Figure; t: number; atS: number }) {
  return (
    <div className="beat-stat" data-reveal={figure.id} style={{ opacity: progressAt(t, atS) }}>
      <span className="beat-stat-label">{figure.label}</span>
      <span className="beat-stat-value">
        {statDisplay(t - atS, figure.value)}
        {figure.unit && <span className="beat-stat-unit">{figure.unit}</span>}
      </span>
    </div>
  );
}

/** stat: one card per figure, each landing on its cue and counting up on a spring. */
export function StatKindBeat({ slots, reveal }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["stat"]>>) {
  const { t } = useBeatTime();
  return (
    <div className="beat-stats" data-qa-level=".beat-stat-value">
      {slots.figures.map((figure, i) => <StatCard key={figure.id} figure={figure} t={t} atS={reveal(figure.id) ?? i * CARD_EACH_S} />)}
    </div>
  );
}
