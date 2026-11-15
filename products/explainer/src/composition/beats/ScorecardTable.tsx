import { useBeatTime } from "@titan-design/react-ui/motion";
import type { ReactNode } from "react";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { litBox, useLit } from "./stage/emphasis.js";
import { progressAt, rise } from "./stage/entrance.js";

/** A row with no cue of its own lands at its index times this, counted from the beat's start. */
const ROW_EACH_S = 0.25;
/** Rows uncover in place, with no rise, so the table never shifts under the stage fit while a row lands. */
const ROW_RISE_PX = 0;

type Slots<K extends keyof typeof BEAT_SLOTS> = z.infer<(typeof BEAT_SLOTS)[K]>;

function TableRow({ id, atS, children }: { id: string; atS: number; children: ReactNode }) {
  const { t } = useBeatTime();
  const lit = useLit()(id, t);
  return (
    <tr className="beat-table-row" data-reveal={id} style={{ ...rise(progressAt(t, atS), ROW_RISE_PX), ...litBox(lit, { base: "var(--color-surface-raised)" }) }}>
      {children}
    </tr>
  );
}

/** metrics-panel: one row per measure with today's figure, and a target cell only where the row has one. */
export function MetricsPanelKindBeat({ slots, reveal }: BeatViewProps<Slots<"metrics-panel">>) {
  return (
    <table className="beat-table">
      <tbody>
        {slots.rows.map((row, i) => (
          <TableRow key={row.id} id={row.id} atS={reveal(row.id) ?? i * ROW_EACH_S}>
            <th scope="row" className="beat-table-label">{row.measure}</th>
            <td className="beat-table-today">{row.today}</td>
            {row.target !== undefined && <td className="beat-table-target">{row.target}</td>}
          </TableRow>
        ))}
      </tbody>
    </table>
  );
}

/** scorecard: one row per call, its reason beside it when the fill gave one. */
export function ScorecardKindBeat({ slots, reveal }: BeatViewProps<Slots<"scorecard">>) {
  return (
    <table className="beat-table">
      <tbody>
        {slots.rows.map((row, i) => (
          <TableRow key={row.id} id={row.id} atS={reveal(row.id) ?? i * ROW_EACH_S}>
            <th scope="row" className="beat-table-label">{row.label}</th>
            <td className="beat-table-call">{row.call}</td>
            {row.reason !== undefined && <td className="beat-table-reason">{row.reason}</td>}
          </TableRow>
        ))}
      </tbody>
    </table>
  );
}
