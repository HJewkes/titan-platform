import { Beat, BeatFrame, MotionProvider, type SeekClock } from "@titan-design/react-ui/motion";
import { resolveBeat } from "./registry.js";
import type { Timeline, TimelineBeat } from "./timeline.js";

const LAYER = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } as const;

function TimelineBeatView({ beat }: { beat: TimelineBeat }) {
  return (
    <Beat startS={beat.startS} durationS={beat.durationS} cues={beat.cues}>
      <div style={LAYER}>
        <BeatFrame kind={beat.kind} className="items-center justify-center">
          {resolveBeat(beat.kind).render(beat.slots)}
        </BeatFrame>
      </div>
    </Beat>
  );
}

/** A timeline on a seek clock: each beat resolved by kind through the registry, in its own window. */
export function Composition({ timeline, clock }: { timeline: Timeline; clock: SeekClock }) {
  return (
    <MotionProvider clock={clock} durationS={timeline.durationS}>
      {timeline.beats.map((beat) => (
        <TimelineBeatView key={beat.id} beat={beat} />
      ))}
    </MotionProvider>
  );
}
