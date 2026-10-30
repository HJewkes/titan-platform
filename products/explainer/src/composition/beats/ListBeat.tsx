import { useBeatTime } from "@titan-design/react-ui/motion";
import { litBox, useLit } from "./stage/emphasis.js";
import { fadeUp, progress, SMALL_EXIT_S } from "./stage/video.js";

/**
 * Port of the daily spike's examples/ListBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat, which the page wraps
 * every beat in. The fill has no payoff row and no tick-less preview, so the payoff spring and `ticks` stay behind.
 */

/**
 * `risk` draws a warning mark, `open` a question mark, `problem` a cross in the error tone and `neutral` a plain dot,
 * so only a row that is done reads as done.
 */
export type ListMark = "tick" | "risk" | "open" | "problem" | "neutral";

const MARK_GLYPH: Record<ListMark, string> = { tick: "✓", risk: "!", open: "?", problem: "✗", neutral: "•" };

export interface ListItem {
  /** The slot element id, set on the row as `data-reveal`, the hook a reveal check finds it by. */
  id: string;
  text: string;
  /** A chip after the text: the row's lane in a daily list. */
  ref?: string;
  /** Beat-local seconds the row arrives, on its spoken cue. */
  atS: number;
  mark: ListMark;
}

interface ListFrameProps {
  heading: string;
  items: readonly ListItem[];
  /**
   * The heading holds the stage until the first row, then exits by this beat-local time. It is out of the flow, so a
   * list with more rows than fit under a heading still has something on the stage before its first cue.
   */
  headingYieldsAtS?: number;
  /** The heading stands alone by design before the first row (a verdict), which QA's late-fill must not flag. */
  leadLine?: boolean;
}

const TICK_DELAY_S = 0.15;

/** Tick scale at beat-local `t`: an eased 0.6 -> 1 once the row has landed. */
function tickScale(t: number, atS: number): number {
  const local = t - atS - TICK_DELAY_S;
  return local <= 0 ? 0 : 0.6 + 0.4 * progress(local, 0);
}

function ListRow({ item, t }: { item: ListItem; t: number }) {
  const tick = tickScale(t, item.atS);
  const lit = useLit()(item.id, t);
  return (
    <li className="ex-list-row" data-reveal={item.id} data-mark={item.mark} style={{ ...fadeUp(t, item.atS, 24), ...litBox(lit, "var(--color-surface-raised)") }}>
      <span className="ex-list-box">
        <span className="ex-list-tick" data-qa-glyph="" style={{ opacity: tick > 0 ? 1 : 0, transform: `scale(${tick})` }}>{MARK_GLYPH[item.mark]}</span>
      </span>
      <span className="ex-list-text">{item.text}</span>
      {item.ref && <span className="ex-list-ref">{item.ref}</span>}
    </li>
  );
}

/** In at 0 s, out (at the exit scale of the entrance) so it is gone by `yieldsAtS`, absolutely placed over the rows. */
function yieldingHeading(t: number, yieldsAtS: number) {
  const out = progress(t, Math.max(0, yieldsAtS - SMALL_EXIT_S), SMALL_EXIT_S);
  const { opacity, transform } = fadeUp(t, 0);
  return { position: "absolute" as const, opacity: opacity * (1 - out), transform };
}

/** Rows tick in on their cues under a heading, and light when a later cue names them again. */
export function ListFrame({ heading, items, headingYieldsAtS, leadLine = false }: ListFrameProps) {
  const { t } = useBeatTime();
  const style = headingYieldsAtS === undefined ? fadeUp(t, 0) : yieldingHeading(t, headingYieldsAtS);
  return (
    <>
      <h2 className="ex-headline" data-list-heading="" {...(leadLine ? { "data-qa-lead-line": "" } : {})} style={style}>{heading}</h2>
      <ul className="ex-list">
        {items.map((item) => <ListRow key={item.id} item={item} t={t} />)}
      </ul>
    </>
  );
}
