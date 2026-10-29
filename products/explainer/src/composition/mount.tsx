// global.css also self-hosts Space Grotesk and Nunito Sans (OFL), the faces the stage CSS names, so no font ships here.
import "@titan-design/react-ui/theme/global.css";
import "./beats/stage/beats.css";
import "./beats/stage/examples.css";
import "./beats/stage/explainer.css";
import { seekClock } from "@titan-design/react-ui/motion";
import { createRoot } from "react-dom/client";
import { Composition } from "./Composition.js";
import type { Timeline } from "./timeline.js";

/**
 * Renders the timeline once it resolves. MotionProvider publishes `window.__titanMotion` in the same commit as the
 * beats, and a capture reads the duration and frame 0 only once that bridge exists, so no frame precedes the
 * timeline. Mounting the provider before the timeline arrives would let a slow fetch capture an empty frame 0.
 */
export async function mountComposition(container: HTMLElement, timeline: Promise<Timeline>): Promise<void> {
  const loaded = await timeline;
  createRoot(container).render(<Composition timeline={loaded} clock={seekClock()} />);
}

export function stageElement(): HTMLElement {
  const stage = document.getElementById("stage");
  if (!stage) throw new Error("the composition page has no #stage element");
  return stage;
}
