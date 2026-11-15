import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { FindingCardBeat } from "./finding-card.js";
import { revealFrom } from "./stage/reveal.js";

const BEAT_S = 6;
const SAMPLED_T_S = [0, 1, 2.5, 4, 5.9];

/** Synthetic: an invented depot's audit findings, one per severity. */
const SLOTS = BEAT_SLOTS["finding-card"].parse({
  findings: [
    { id: "finding-1", title: "Scanner gate skips a parcel", severity: "high", status: "open", round: 2 },
    { id: "finding-2", title: "Label printer retries twice", severity: "medium", status: "fixed" },
    { id: "finding-3", title: "Dock sign is out of date", severity: "low", status: "waived", round: 1 },
  ],
});
const CUES = revealFrom([
  { target: "finding-1", atS: 1 },
  { target: "finding-2", atS: 2 },
]);

function htmlAt(t: number): string {
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={BEAT_S}>
        <FindingCardBeat slots={SLOTS} reveal={CUES} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

const rowOf = (html: string, id: string): string => new RegExp(`<li[^>]*data-reveal="${id}"[^>]*>.*?</li>`).exec(html)?.[0] ?? "";

describe("the finding-card beat", () => {
  it("draws high as a problem, medium as a risk and low as neutral", () => {
    // Arrange
    const html = htmlAt(5);

    // Act
    const marks = ["finding-1", "finding-2", "finding-3"].map((id) => /data-mark="([^"]*)"/.exec(rowOf(html, id))?.[1]);

    // Assert
    expect(marks).toEqual(["problem", "risk", "neutral"]);
  });

  it("puts status and round in the chip, and the status alone when there is no round", () => {
    // Arrange
    const html = htmlAt(5);

    // Act
    const chips = ["finding-1", "finding-2", "finding-3"].map((id) => /class="ex-list-ref">([^<]*)</.exec(rowOf(html, id))?.[1]);

    // Assert
    expect(chips).toEqual(["open · round 2", "fixed", "waived · round 1"]);
  });

  it("lands a finding with no cue at 0, so it is drawn from the first frame", () => {
    // Arrange
    const html = htmlAt(0.5);

    // Act
    const [uncued, cued] = [rowOf(html, "finding-3"), rowOf(html, "finding-1")];

    // Assert
    expect(uncued).not.toMatch(/opacity:0(?![.\d])/);
    expect(cued).toMatch(/opacity:0(?![.\d])/);
  });

  it("draws the same markup seeking cold to a time as sweeping to it", () => {
    // Arrange
    const sweep = SAMPLED_T_S.map((t) => htmlAt(t));

    // Act
    const cold = [...SAMPLED_T_S].reverse().map((t) => htmlAt(t)).reverse();

    // Assert
    expect(cold).toEqual(sweep);
  });
});
