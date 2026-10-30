import { interpolate, MOTION, useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { enter, rise } from "./stage/entrance.js";
import { OUTRO_FADE_OUT_S } from "./stage/outro-fade.js";

/**
 * Port of the daily spike's OutroBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat. The fill gives one line and at
 * most one action, so the spike's subtitle and link list become the line and the action.
 */

const ACTION_S = 0.9;

/** 1 until the last `OUTRO_FADE_OUT_S` of the beat, then down to 0 at its end; it drives a rise-and-clip exit, never an opacity. */
const outroPresence = (t: number, durationS: number): number => interpolate(t, [durationS - OUTRO_FADE_OUT_S, durationS], [1, 0], { ease: MOTION.ease.inOut });

interface OutroFrameProps {
  line: string;
  lineAtS: number;
  action?: { label: string; href?: string };
}

function OutroFrame({ line, lineAtS, action }: OutroFrameProps) {
  const { t, durationS } = useBeatTime();
  return (
    <div className="beat-outro" style={rise(outroPresence(t, durationS), 24)}>
      <h1 className="beat-title" data-reveal="line" style={enter(t, lineAtS)}>{line}</h1>
      {action && (
        <div className="beat-outro-links" data-outro-action="" style={enter(t, lineAtS + ACTION_S)}>
          <a {...(action.href === undefined ? {} : { href: action.href })}>{action.label}</a>
        </div>
      )}
    </div>
  );
}

/** button: the line rises in on its word, the action follows, and both fade at the beat's end. */
export function ButtonBeat({ slots, reveal }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["button"]>>) {
  const action = { label: slots.action, ...(slots.href === undefined ? {} : { href: slots.href }) };
  return <OutroFrame line={slots.line} lineAtS={reveal("line") ?? 0} action={action} />;
}

/** outro: the closing line, then fade; the button's fallback when it has no action. */
export function OutroKindBeat({ slots, reveal }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["outro"]>>) {
  return <OutroFrame line={slots.line} lineAtS={reveal("line") ?? 0} />;
}
