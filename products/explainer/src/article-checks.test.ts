import { beforeAll, describe, expect, it } from "vitest";
import { paperPublishEligibility } from "./article-checks.js";
import { demoBoard as board, edited, gatherDemo } from "./article-fixtures.test-helpers.js";
import type { ArticleFact } from "./presets/article/schemas.js";
import { loadProfiles, profileFor } from "./profile-load.js";

let facts: ArticleFact[];
beforeAll(async () => {
  ({ facts } = await gatherDemo());
});

describe("paper publish eligibility", () => {
  it("makes a video eligible when every figure is re-plotted from its data and every quote is short, and still requires the owner's ask", () => {
    expect(paperPublishEligibility(board(), facts)).toEqual({ eligible: true, ownerAskRequired: true, issues: [] });
  });

  it("fails a beat that shows a figure as an image", () => {
    const video = edited((beats) => (beats[2]!.slots = { image: "assets/figure-2.PNG" }));

    const result = paperPublishEligibility(video, facts);

    expect(result.eligible).toBe(false);
    expect(result.issues).toEqual([{ check: "figures-replotted-from-data", beat: "beat-03", message: "beat-03 shows an image; a figure is re-plotted from data, never a picture of it" }]);
  });

  it("fails an inline data-url image nested deep in the slots", () => {
    const video = edited((beats) => (beats[2]!.slots = { cards: [{ id: "a", art: { src: "data:image/png;base64,AAAA" } }] }));

    expect(paperPublishEligibility(video, facts).issues.map((issue) => issue.beat)).toEqual(["beat-03"]);
  });

  it("fails a non-replot beat that shows a gathered figure", () => {
    const video = edited((beats) => beats[2]!.sources.push("figure/table-2"));

    expect(paperPublishEligibility(video, facts).issues[0]?.message).toBe("beat-03 shows figure/table-2 as a stat beat; a figure is shown only as a replot of its data");
  });

  it("implements every publish check the paper-summary profile names", () => {
    const checks = profileFor(loadProfiles(), "paper-summary").publish?.checks ?? [];
    const video = edited((beats) => (beats[2]!.slots = { image: "figure.png" }));

    expect(paperPublishEligibility(board(), facts, checks).eligible).toBe(true);
    expect(paperPublishEligibility(video, facts, checks).eligible).toBe(false);
  });

  it("runs only the checks the profile names", () => {
    const video = edited((beats) => (beats[2]!.slots = { image: "figure.png" }));

    expect(paperPublishEligibility(video, facts, ["quotes-short"]).eligible).toBe(true);
  });

  it("fails a video on a check it does not implement, and on a profile naming no checks", () => {
    expect(paperPublishEligibility(board(), facts, ["quotes-short", "licence-cleared"]).issues).toEqual([{ check: "licence-cleared", message: "publish check licence-cleared is not implemented; the video is not eligible" }]);
    expect(paperPublishEligibility(board(), facts, []).eligible).toBe(false);
  });
});
