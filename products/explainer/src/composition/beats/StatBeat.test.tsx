import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { revealFrom } from "./stage/reveal.js";
import { StatKindBeat } from "./StatBeat.js";

/** Synthetic: parcels scanned at an invented depot, and a shrinking queue as a negative figure. */
const SCANNED = 250;
const QUEUE = -40;
const FIGURES = [
  { id: "figures-1", label: "Parcels scanned", value: SCANNED },
  { id: "figures-2", label: "Queue change", value: QUEUE },
];

/** Every tenth of a second over the first four seconds: the whole count-up and its settle. */
const SAMPLES_S = Array.from({ length: 41 }, (_, i) => i / 10);

function htmlAt(t: number, figures: unknown): string {
  const slots = BEAT_SLOTS.stat.parse({ figures });
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={6}>
        <StatKindBeat slots={slots} reveal={revealFrom([])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

function shownAt(t: number): number[] {
  const html = htmlAt(t, FIGURES);
  return [...html.matchAll(/class="beat-stat-figure"[^>]*>(-?[\d.]+)</g)].map((m) => Number(m[1]));
}

describe("a stat card counting up to its figure", () => {
  it("the count never shows a value past its figure", () => {
    // Arrange
    const samples = SAMPLES_S;

    // Act
    const shown = samples.map(shownAt);

    // Assert
    expect(shown.every(([scanned = Infinity, queue = -Infinity]) => scanned <= SCANNED && queue >= QUEUE)).toBe(true);
    expect(shown.at(-1)).toEqual([SCANNED, QUEUE]);
  });
});

describe("a stat card whose figure is not a plain count", () => {
  const TILES = [
    { id: "figures-1", label: "Per unit", prefix: "$", value: 13.41 },
    { id: "figures-2", label: "Table", prefix: "v", value: 1 },
  ];
  const textAt = (t: number) => [...htmlAt(t, TILES).matchAll(/class="beat-stat-value"[^>]*>(.*?)<\/span><\/span>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

  it("draws a version whole from its first frame while the currency beside it counts up", () => {
    // Arrange
    const early = 0.3;

    // Act
    const shown = textAt(early);

    // Assert
    expect(shown[1]).toBe("v1");
    expect(shown[0]).not.toBe("$13.41");
  });

  it("settles on every decimal the figure has, so 13.41 is not rounded to 13.4", () => {
    // Arrange
    const settled = 4;

    // Act
    const shown = textAt(settled);

    // Assert
    expect(shown).toEqual(["$13.41", "v1"]);
  });
});
