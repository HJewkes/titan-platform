import { Typography } from "@titan-design/react-ui";
import { Beat, BeatFrame, MotionProvider, type SeekClock } from "@titan-design/react-ui/motion";
import type { ReactElement } from "react";
import { Chrome, Stage } from "./beats/stage/Chrome.js";
import { BeatFrame as StageFrame } from "./beats/stage/BeatFrame.js";
import { RevealContext, revealFrom } from "./beats/stage/reveal.js";
import { CustomLayer } from "./custom-layer.js";
import { resolveBeat } from "./registry.js";
import type { Timeline, TimelineBeat } from "./timeline.js";

const LAYER = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } as const;

interface ViewProps {
  beat: TimelineBeat;
  view: ReactElement;
  headline: boolean;
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
function StageBeat({ beat, view, headline }: ViewProps) {
  return (
    <RevealContext value={revealFrom(beat.reveals ?? [])}>
      <Stage beat={beat.id}>
        <StageFrame kind={beat.kind}>{view}</StageFrame>
      </Stage>
      <Chrome headline={headline ? beat.headline : undefined} chips={beat.chips ?? []} chapter={beat.chapter} />
    </RevealContext>
  );
}

/**
 * react-ui's Beat reads `now - startS >= durationS` as over. At the next beat's start that subtraction can land one ulp
 * short of durationS, so both beats would draw the boundary frame (QA reads two chromes). A nanosecond off each
 * window leaves exactly one beat at every boundary and moves no frame a viewer could see.
 */
const BOUNDARY_S = 1e-9;

/**
 * A custom layer draws in the stage box between empty chrome bands, as a stage kind does, so its content clears the
 * chrome by construction and qa's under-chrome rule sees any overflow. Its anchors are cells of the stage box.
 */
function CustomLayerBeatView({ beat, module }: { beat: TimelineBeat; module: string }) {
  return (
    <Beat startS={beat.startS} durationS={beat.durationS - BOUNDARY_S} cues={beat.cues}>
      <Stage beat={beat.id}>
        <BeatFrame kind={beat.kind} className="absolute inset-0">
          <CustomLayer url={module} />
        </BeatFrame>
      </Stage>
      <Chrome chips={[]} />
    </Beat>
  );
}

function TimelineBeatView({ beat }: { beat: TimelineBeat }) {
  if (beat.layer === "custom" && beat.module !== undefined) return <CustomLayerBeatView beat={beat} module={beat.module} />;
  const definition = resolveBeat(beat.kind);
  const view = definition.render(beat.slots, { hints: beat.hints ?? {}, ...(beat.chapter ? { chapter: beat.chapter.label } : {}) });
  const Frame = definition.stage ? StageBeat : PageBeat;
  return (
    <Beat startS={beat.startS} durationS={beat.durationS - BOUNDARY_S} cues={beat.cues}>
      <Frame beat={beat} view={view} headline={definition.headline} />
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
