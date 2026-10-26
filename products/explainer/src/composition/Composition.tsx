import { Typography } from "@titan-design/react-ui";
import { Beat, BeatFrame, MotionProvider, type SeekClock } from "@titan-design/react-ui/motion";
import type { ReactElement } from "react";
import { Chrome, Stage } from "./beats/stage/Chrome.js";
import { BeatFrame as StageFrame } from "./beats/stage/BeatFrame.js";
import { RevealContext, revealFrom } from "./beats/stage/reveal.js";
import { resolveBeat } from "./registry.js";
import type { Timeline, TimelineBeat } from "./timeline.js";

const LAYER = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } as const;

interface ViewProps {
  beat: TimelineBeat;
  view: ReactElement;
}

/** A page kind owns the whole canvas, with no chrome. */
function PageBeat({ beat, view }: ViewProps) {
  return (
    <div style={LAYER}>
      <BeatFrame kind={beat.kind} className="items-center justify-center">
        {view}
      </BeatFrame>
    </div>
  );
}

/** A stage kind sits in the box between the chrome bands, its elements landing on their reveal times. */
function StageBeat({ beat, view }: ViewProps) {
  return (
    <RevealContext value={revealFrom(beat.reveals ?? [])}>
      <Stage beat={beat.id}>
        <StageFrame kind={beat.kind}>{view}</StageFrame>
      </Stage>
      <Chrome headline={beat.headline} chips={beat.chips ?? []} chapter={beat.chapter} />
    </RevealContext>
  );
}

function TimelineBeatView({ beat }: { beat: TimelineBeat }) {
  const definition = resolveBeat(beat.kind);
  const view = definition.render(beat.slots, beat.hints ?? {});
  const Frame = definition.stage ? StageBeat : PageBeat;
  return (
    <Beat startS={beat.startS} durationS={beat.durationS} cues={beat.cues}>
      <Frame beat={beat} view={view} />
    </Beat>
  );
}

const DRAFT_BADGE = { position: "absolute", top: 32, right: 40, zIndex: 1 } as const;

/** A timeline on a seek clock: each beat resolved by kind through the registry, in its own window. */
export function Composition({ timeline, clock }: { timeline: Timeline; clock: SeekClock }) {
  return (
    <MotionProvider clock={clock} durationS={timeline.durationS}>
      {timeline.beats.map((beat) => (
        <TimelineBeatView key={beat.id} beat={beat} />
      ))}
      {timeline.provisional ? (
        <div style={DRAFT_BADGE} data-testid="draft-badge">
          <Typography variant="overline" color="warning">DRAFT</Typography>
        </div>
      ) : null}
    </MotionProvider>
  );
}
