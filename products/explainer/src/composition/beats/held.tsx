import { useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { fadeUp } from "./stage/video.js";

/** A held beat: the picture rests under the chrome, with its one line when it has one. */
export function HeldBeat({ slots }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["held"]>>) {
  const { t } = useBeatTime();
  if (slots.line === undefined) return null;
  return <p className="beat-heading" data-held-line style={{ ...fadeUp(t, 0), textAlign: "center" }}>{slots.line}</p>;
}
