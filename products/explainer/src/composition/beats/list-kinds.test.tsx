import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { VerdictCardBeat } from "./list-kinds.js";
import { revealFrom } from "./stage/reveal.js";

const REASONS = [{ id: "reasons-1", text: "Both depot lanes keep their order" }];

function htmlOf(verdict: string, call?: string): string {
  const slots = BEAT_SLOTS["verdict-card"].parse({ verdict, reasons: REASONS, ...(call === undefined ? {} : { call }) });
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(1)}>
      <Beat startS={0} durationS={6}>
        <VerdictCardBeat slots={slots} reveal={revealFrom([])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

const chipOf = (html: string) => html.match(/<[^>]*data-verdict-call[^>]*>(.*?)<\/[a-z]+>/s);
const headingOf = (html: string) => html.match(/data-list-heading[^>]*>(.*?)<\/h2>/s)?.[1];
const toneOf = (html: string) => html.match(/data-verdict-call="([a-z]+)"/)?.[1];

describe("a verdict card's call", () => {
  it("draws 'Ship it' as a success chip and drops the duplicated prefix from the heading", () => {
    // Arrange
    const html = htmlOf("Ship it: lanes hold", "Ship it");

    // Act
    const chip = chipOf(html);

    // Assert
    expect(toneOf(html)).toBe("success");
    expect(chip?.[1]).toContain("Ship it");
    expect(headingOf(html)).toBe("lanes hold");
  });

  it.each([
    ["Fix first", "warning"],
    ["Avoid", "error"],
  ])("draws '%s' in the %s tone", (call, tone) => {
    // Arrange
    const html = htmlOf(`${call}: reason`, call);

    // Act
    const drawn = toneOf(html);

    // Assert
    expect(drawn).toBe(tone);
  });

  it("draws no chip and keeps the whole heading when the card has no call", () => {
    // Arrange
    const html = htmlOf("Ship it: lanes hold");

    // Act
    const chip = chipOf(html);

    // Assert
    expect(chip).toBeNull();
    expect(headingOf(html)).toBe("Ship it: lanes hold");
  });

  it("draws an unknown call word in the neutral tone", () => {
    // Arrange
    const html = htmlOf("Maybe: unclear", "Maybe");

    // Act
    const drawn = toneOf(html);

    // Assert
    expect(drawn).toBe("neutral");
  });
});
