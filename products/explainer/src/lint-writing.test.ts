import { describe, expect, it } from "vitest";
import { REGISTER_CHECK_IDS, spokenText } from "./lint-register.js";
import { adjacentDelta, WRITING_BANDS } from "./lint-writing.js";

const measure = (...spoken: string[]): number | undefined => adjacentDelta(spokenText(spoken));

describe("adjacentDelta", () => {
  it("is the mean step over the mean length, hand-counted on sentences of 2, 6, 2 and 8 words", () => {
    const text = "One two. A b c d e f. Go now. Eight words in this final long sentence here.";

    const value = measure(text);

    // Steps 4, 4, 6 average 14/3; lengths 2, 6, 2, 8 average 4.5.
    expect(value).toBeCloseTo(14 / 3 / 4.5, 9);
  });

  it("is zero when every sentence has the same length", () => {
    expect(measure("One two three. Four five six. Seven eight nine.")).toBe(0);
  });

  it("reads sentences across beats, so a step can span two beats", () => {
    expect(measure("One two.", "A b c d e f.", "Go now.")).toBeCloseTo(4 / (10 / 3), 9);
  });

  it("cannot carry under 3 sentences", () => {
    expect(measure("One two three. Four five six.")).toBeUndefined();
  });

  it("cannot carry text with too little punctuation to read", () => {
    const unpunctuated = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");

    expect(measure(`${unpunctuated}. One two. Three four.`)).toBeUndefined();
  });

  it("never passes its band's ceiling, even at the three-sentence extreme", () => {
    const value = measure(`One. ${Array.from({ length: 140 }, () => "word").join(" ")}. One.`);

    expect(value).toBeLessThanOrEqual(WRITING_BANDS["adjacent-delta"].max);
  });
});

describe("the writing rows", () => {
  it("keep adjacent-delta out of the L0 register check, so the script stage never warns on it", () => {
    expect(REGISTER_CHECK_IDS).not.toContain("register:adjacent-delta");
  });
});
