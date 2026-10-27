import { MOTION, useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { enter, progressAt } from "./stage/entrance.js";
import type { Reveal } from "./stage/reveal.js";

/**
 * Port of the daily spike's CompareBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. The fill gives no winning
 * rows, so the improve highlight stays behind. Each side lands on the first of its own part's reveals, where the
 * spike's adapter pinned the left at 0.2 s and wiped the right in half a second early.
 */

type CompareSlots = z.infer<(typeof BEAT_SLOTS)["compare"]>;
type Part = "left" | "right";

interface Cell {
  /** The slot element id, set on the cell as `data-reveal`. */
  id: string;
  text: string;
  atS: number;
}

const WIPE_S = 0.8;

/** CSS clip that reveals the left `p` of an element; at 0.5 exactly half shows. */
const wipeClip = (p: number): string => `inset(0 ${(1 - p) * 100}% 0 0)`;

function CompareColumn({ title, cells, t, accent }: { title: string; cells: readonly Cell[]; t: number; accent?: boolean }) {
  return (
    <>
      <div className="beat-compare-title" data-accent={accent} data-qa-title="">{title}</div>
      {cells.map((cell) => (
        <div key={cell.id} className="beat-compare-row" data-reveal={cell.id} style={enter(t, cell.atS)}>{cell.text}</div>
      ))}
    </>
  );
}

/** A row's left cell is named by its id and its right cell by its alias, the label numbers the cues name. */
const cellId = (row: CompareSlots["rows"][number], part: Part): string => (part === "left" ? row.id : (row.alias ?? `${row.id}-right`));

/** One side's cells, each on its own cue, else with its side. */
function sideCells(slots: CompareSlots, reveal: Reveal, part: Part, landsAtS: number): Cell[] {
  return slots.rows.map((row) => ({ id: cellId(row, part), text: row[part], atS: reveal(cellId(row, part), part) ?? landsAtS }));
}

/** The first cue of a side's part, or `fallbackS` when the side has none. */
function sideLanding(slots: CompareSlots, reveal: Reveal, part: Part, fallbackS: number): number {
  const times = slots.rows.flatMap((row) => reveal(cellId(row, part), part) ?? []);
  return times.length === 0 ? fallbackS : Math.min(...times);
}

/** compare: two cards side by side; the left fades in on its first cue, the right wipes in on its own. */
export function CompareKindBeat({ slots, reveal }: BeatViewProps<CompareSlots>) {
  const { t } = useBeatTime();
  const leftAtS = sideLanding(slots, reveal, "left", 0);
  const rightAtS = sideLanding(slots, reveal, "right", leftAtS);
  return (
    <div className="beat-compare" data-qa-order=".beat-compare-row">
      <div className="beat-card beat-compare-side" style={enter(t, leftAtS)}>
        <CompareColumn title={slots.leftTitle} cells={sideCells(slots, reveal, "left", leftAtS)} t={t} />
      </div>
      <div className="beat-card beat-compare-side" style={{ clipPath: wipeClip(progressAt(t, rightAtS, WIPE_S, MOTION.ease.inOut)) }}>
        <CompareColumn title={slots.rightTitle} cells={sideCells(slots, reveal, "right", rightAtS)} t={t} accent />
      </div>
    </div>
  );
}
