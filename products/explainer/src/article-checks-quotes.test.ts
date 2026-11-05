import { beforeAll, describe, expect, it } from "vitest";
import { paperPublishEligibility } from "./article-checks.js";
import { demoBoard as board, edited, gatherDemo, type Beats } from "./article-fixtures.test-helpers.js";
import { BEAT_SLOTS } from "./beat-slots.js";
import type { ArticleFact } from "./presets/article/schemas.js";

let facts: ArticleFact[];
beforeAll(async () => {
  ({ facts } = await gatherDemo());
});

const LONG_QUOTE = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six";

function editQuote(beats: Beats, text: string): void {
  const slots = BEAT_SLOTS["claim-card"].parse(beats[0]!.slots);
  slots.quote!.text = text;
  beats[0]!.slots = slots;
}

describe("paper publish eligibility", () => {
  it("fails a slot quote over the length limit", () => {
    const video = edited((beats) => editQuote(beats, LONG_QUOTE));

    expect(paperPublishEligibility(video, facts).issues).toEqual([{ check: "quotes-short", beat: "beat-01", message: "beat-01 quotes 26 words; the limit is 25" }]);
  });

  it("fails a plain-string quote slot and a quote read out in the narration or shown on screen", () => {
    const video = edited((beats) => {
      beats[0]!.slots = { claim: "c", quote: LONG_QUOTE };
      beats[1]!.spoken = `They wrote “${LONG_QUOTE}” in the paper.`;
      beats[2]!.display = `"${LONG_QUOTE}"`;
    });

    expect(paperPublishEligibility(video, facts).issues.map((issue) => [issue.check, issue.beat])).toEqual([
      ["quotes-short", "beat-01"],
      ["quotes-short", "beat-02"],
      ["quotes-short", "beat-03"],
    ]);
  });

  it("allows a quote of exactly the limit, and applies a tighter limit when given one", () => {
    const limit = LONG_QUOTE.split(" ").slice(0, 25).join(" ");
    const video = edited((beats) => editQuote(beats, limit));

    expect(paperPublishEligibility(video, facts).eligible).toBe(true);
    expect(paperPublishEligibility(board(), facts, undefined, 10).issues.map((issue) => issue.beat)).toEqual(["beat-01"]);
  });
});
