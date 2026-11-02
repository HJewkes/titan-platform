import { spring, useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { litBox, useLit } from "./stage/emphasis.js";
import { progressAt, rise } from "./stage/entrance.js";

/**
 * Port of the daily spike's StatBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. The fill gives figures and no
 * delta chip, so the delta pill stays behind with the figures' delta, interval and grade, which no daily fills.
 */

type Figure = z.infer<(typeof BEAT_SLOTS)["stat"]>["figures"][number];

const COUNT_START_S = 0.2;
const COUNT_SPRING = { stiffness: 120, damping: 18 } as const;
/** A figure with no cue of its own lands at its index times this, counted from the beat's start. */
const CARD_EACH_S = 0.25;
/**
 * The card uncovers in place, with no rise: its figure starts counting while the card still enters, and qa reads a
 * count as one figure only while it holds one place, so a figure caught a few px short reads as a number of its own.
 */
const CARD_RISE_PX = 0;

/** The figure's own decimals, so 13.41 is drawn as 13.41 and never rounded to a value the narration does not say. */
const places = (value: number) => (String(value).split(".")[1] ?? "").length;

/** A version tag (`v1`) is an identifier, not a quantity: it is drawn whole from the first frame and never counts. */
const counts = (prefix: string | undefined) => !prefix || !/^[a-z]/i.test(prefix);

/**
 * The value shown `local` seconds after the card lands: a spring from 0 that settles on the figure. The spring
 * overshoots, and the count stops at the figure, so the card never shows a number the figure is not.
 */
function statDisplay(local: number, value: number, prefix: string | undefined): string {
  if (!counts(prefix)) return value.toFixed(places(value));
  const counted = spring(local - COUNT_START_S, { ...COUNT_SPRING, to: value });
  return (value < 0 ? Math.max(counted, value) : Math.min(counted, value)).toFixed(places(value));
}

function StatCard({ figure, t, atS }: { figure: Figure; t: number; atS: number }) {
  const lit = useLit()(figure.id, t);
  return (
    <div className="beat-stat" data-reveal={figure.id} style={{ ...rise(progressAt(t, atS), CARD_RISE_PX), ...litBox(lit, { base: "var(--color-surface-raised)" }) }}>
      <span className="beat-stat-label">{figure.label}</span>
      <span className="beat-stat-value">
        {figure.prefix && <span className="beat-stat-prefix">{figure.prefix}</span>}
        <span className="beat-stat-figure" style={{ minWidth: `${figure.value.toFixed(places(figure.value)).length}ch` }}>{statDisplay(t - atS, figure.value, figure.prefix)}</span>
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
