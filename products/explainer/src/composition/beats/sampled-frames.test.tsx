import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { ButtonBeat, OutroKindBeat } from "./OutroBeat.js";
import { StatKindBeat } from "./StatBeat.js";
import { revealFrom } from "./stage/reveal.js";

const BEAT_S = 6;
const FRAME_S = 1 / 30;
/** qa's settled sample of a closing beat and the video's own last frame. */
const CLOSING_FRAMES_S = [BEAT_S - 0.2, BEAT_S - FRAME_S];
/** Every frame of the first second: the card's entrance and the whole count-up. */
const ENTRANCE_FRAMES_S = Array.from({ length: 31 }, (_, i) => i * FRAME_S);
const SETTLED_FRAMES_S = [1, 2, 3, 4, 5, BEAT_S - FRAME_S];

/** Synthetic: an invented depot's closing line and its parcel count. */
const SCANNED = 250;
const STAT = BEAT_SLOTS.stat.parse({ figures: [{ id: "figures-1", label: "Parcels scanned", value: SCANNED }] });
const BUTTON = BEAT_SLOTS.button.parse({ line: "See you at the depot", action: "Open the map" });
const OUTRO = BEAT_SLOTS.outro.parse({ line: "See you at the depot" });

function htmlAt(view: ReactElement, t: number): string {
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={BEAT_S}>{view}</Beat>
    </MotionProvider>,
  );
}

/** The figure's text and its card's vertical offset in px, or undefined while the card is hidden. */
function statFrame(t: number): { figure: string; offsetPx: number } | undefined {
  const html = htmlAt(<StatKindBeat slots={STAT} reveal={revealFrom([])} hints={{}} />, t);
  const style = /class="beat-stat"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
  if (/opacity:0(?![.\d])/.test(style)) return undefined;
  const figure = /class="beat-stat-figure"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
  return { figure, offsetPx: Number(/translateY\((-?[\d.]+)px\)/.exec(style)?.[1] ?? 0) };
}

describe("a template on the frames qa samples", () => {
  it.each([
    ["button", <ButtonBeat slots={BUTTON} reveal={revealFrom([])} hints={{}} />],
    ["outro", <OutroKindBeat slots={OUTRO} reveal={revealFrom([])} hints={{}} />],
  ])("a closing %s holds its text uncut through the video's last frame", (_kind, view) => {
    // Arrange
    const frames = CLOSING_FRAMES_S;

    // Act
    const htmls = frames.map((t) => htmlAt(view, t));

    // Assert
    for (const html of htmls) {
      expect(html).toContain("See you at the depot");
      expect(html).not.toMatch(/clip-path/);
    }
  });

  it("a stat figure counts in the one place it first shows, so qa reads the count as one figure", () => {
    // Arrange
    const frames = ENTRANCE_FRAMES_S;

    // Act
    const shown = frames.flatMap((t) => statFrame(t) ?? []);

    // Assert
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown.map((frame) => frame.offsetPx))).toEqual(new Set([0]));
  });

  it("a stat figure holds its final value from its settle to the beat's end", () => {
    // Arrange
    const frames = SETTLED_FRAMES_S;

    // Act
    const figures = frames.map((t) => statFrame(t)?.figure);

    // Assert
    expect(figures).toEqual(frames.map(() => String(SCANNED)));
  });
});
