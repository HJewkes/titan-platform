import { spring, useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { litBox, useLit } from "./stage/emphasis.js";
import { progressAt } from "./stage/entrance.js";

/**
 * Port of the daily spike's StatBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. The fill gives figures and no
 * delta chip, so the delta pill stays behind with the figures' delta, interval and grade, which no daily fills.
 */

type Figure = z.infer<(typeof BEAT_SLOTS)["stat"]>["figures"][number];

const COUNT_START_S = 0.2;
const COUNT_SPRING = { stiffness: 120, damping: 18 } as const;
/** A figure with no cue of its own lands at its index times this, counted from the beat's start. */
const CARD_EACH_S = 0.25;

const places = (value: number) => (Number.isInteger(value) ? 0 : 1);

/**
 * The value shown `local` seconds after the card lands: a spring from 0 that settles on the figure. The spring
 * overshoots, and the count stops at the figure, so the card never shows a number the figure is not.
 */
function statDisplay(local: number, value: number): string {
  const counted = spring(local - COUNT_START_S, { ...COUNT_SPRING, to: value });
  return (value < 0 ? Math.max(counted, value) : Math.min(counted, value)).toFixed(places(value));
}

function StatCard({ figure, t, atS }: { figure: Figure; t: number; atS: number }) {
  const lit = useLit()(figure.id, t);
  return (
    <div className="beat-stat" data-reveal={figure.id} style={{ opacity: progressAt(t, atS), ...litBox(lit, "var(--color-surface-raised)") }}>
      <span className="beat-stat-label">{figure.label}</span>
      <span className="beat-stat-value">
        <span className="beat-stat-figure" style={{ minWidth: `${figure.value.toFixed(places(figure.value)).length}ch` }}>{statDisplay(t - atS, figure.value)}</span>
        {figure.unit && <span className="beat-stat-unit">{figure.unit}</span>}
      </span>
    </div>
  );
}

/** stat: one card per figure, each landing on its cue and counting up on a spring, lit when a later cue names it. */
export function StatKindBeat({ slots, reveal }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["stat"]>>) {
  const { t } = useBeatTime();
  return (
    <div className="beat-stats" data-qa-level=".beat-stat-value">
      {slots.figures.map((figure, i) => <StatCard key={figure.id} figure={figure} t={t} atS={reveal(figure.id) ?? i * CARD_EACH_S} />)}
    </div>
  );
}
