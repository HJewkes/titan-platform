import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { revealFrom } from "./stage/reveal.js";
import { StatKindBeat } from "./StatBeat.js";

/** Synthetic: parcels scanned at an invented depot, and a shrinking queue as a negative figure. */
const FIGURES = [
  { id: "figures-1", label: "Parcels scanned", value: 250 },
  { id: "figures-2", label: "Queue change", value: -40 },
];

/** Every tenth of a second over the first four seconds: the whole count-up and its settle. */
const SAMPLES_S = Array.from({ length: 41 }, (_, i) => i / 10);

function shownAt(t: number): number[] {
  const slots = BEAT_SLOTS.stat.parse({ figures: FIGURES });
  const html = renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={6}>
        <StatKindBeat slots={slots} reveal={revealFrom([])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
  return [...html.matchAll(/class="beat-stat-figure"[^>]*>(-?[\d.]+)</g)].map((m) => Number(m[1]));
}

describe("a stat card counting up to its figure", () => {
  it("the count never shows a value past its figure", () => {
    // Arrange
    const [scanned, queue] = FIGURES.map((figure) => figure.value) as [number, number];

    // Act
    const shown = SAMPLES_S.map(shownAt);

    // Assert
    expect(shown.every(([a, b]) => a! <= scanned && b! >= queue)).toBe(true);
    expect(shown.at(-1)).toEqual([scanned, queue]);
  });
});
