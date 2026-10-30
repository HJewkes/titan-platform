import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { revealFrom } from "./stage/reveal.js";
import { ArchMapKindBeat } from "./ArchMapBeat.js";

/** Synthetic: three stops on an invented delivery route. */
const STOPS = ["depot", "sorter", "van"];
const SLOTS = BEAT_SLOTS.map.parse({
  title: "Route",
  nodes: STOPS.map((label, i) => ({ id: `nodes-${i + 1}`, label })),
  edges: STOPS.slice(1).map((_, i) => ({ id: `edges-${i + 1}`, from: `nodes-${i + 1}`, to: `nodes-${i + 2}` })),
});

function mapStyleAt(t: number): string {
  const html = renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={6}>
        <ArchMapKindBeat slots={SLOTS} reveal={revealFrom([])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
  return /class="ex-map"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("an arch-map entering", () => {
  it("the map's step numbers are at full colour on the beat's first frames", () => {
    // Arrange
    const firstFrameS = 0.1;

    // Act
    const style = mapStyleAt(firstFrameS);

    // Assert
    expect(style).not.toBe("");
    expect(style).not.toMatch(/opacity:\s*0\.\d/);
  });
});
