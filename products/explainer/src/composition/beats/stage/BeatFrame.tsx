import { BeatFrame as MotionBeatFrame, useBeatTime } from "@titan-design/react-ui/motion";
import { useRef, type ReactNode } from "react";
import { useStageFit } from "./stageFit.js";

/**
 * react-ui's BeatFrame with the spike frame's behaviour inside it: the `.beat-frame` box the stage CSS sizes,
 * `data-beat` for QA, and the stage-fit check. `visibility` is always set: dropping a style key leaves `style=""`
 * behind, so the DOM would depend on seek history. Inside a stage, content shrinks to fit the box down to the type
 * floor, and what still overflows there throws.
 */
export function BeatFrame({ kind, children }: { kind: string; children?: ReactNode }) {
  const { phase } = useBeatTime();
  const ref = useRef<HTMLDivElement>(null);
  useStageFit(ref);
  return (
    <MotionBeatFrame kind={kind}>
      <div ref={ref} className="beat-frame" data-beat={kind} style={{ visibility: phase === "during" ? "visible" : "hidden" }}>
        {children}
      </div>
    </MotionBeatFrame>
  );
}
