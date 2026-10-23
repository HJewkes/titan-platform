import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { paperPublishEligibility } from "./article-checks.js";
import { edited, gatherDemo, type Beats } from "./article-fixtures.test-helpers.js";
import { BEAT_SLOTS } from "./beat-slots.js";
import type { ArticleFact } from "./presets/article/schemas.js";

let facts: ArticleFact[];
beforeAll(async () => {
  ({ facts } = await gatherDemo());
});

function editReplot(beats: Beats, change: (slots: z.infer<typeof BEAT_SLOTS.replot>) => void): void {
  const slots = BEAT_SLOTS.replot.parse(beats[1]!.slots);
  change(slots);
  beats[1]!.slots = slots;
}

describe("paper publish eligibility", () => {
  it("fails a replot whose points are not the figure's data", () => {
    const video = edited((beats) => editReplot(beats, (slots) => (slots.series[1]!.points[2]!.y = 1.2)));

    expect(paperPublishEligibility(video, facts).issues).toEqual([{ check: "figures-replotted-from-data", beat: "beat-02", message: "replot beat-02 plots points that are not figure/figure-1's data" }]);
  });

  it("fails a replot that drops a point, and a replot with no series", () => {
    const dropped = edited((beats) => editReplot(beats, (slots) => slots.series[0]!.points.pop()));
    const empty = edited((beats) => (beats[1]!.slots = { ...beats[1]!.slots, series: [] }));

    expect(paperPublishEligibility(dropped, facts).eligible).toBe(false);
    expect(paperPublishEligibility(empty, facts).eligible).toBe(false);
  });

  it("fails a replot citing a source that is not a gathered figure", () => {
    const video = edited((beats) => editReplot(beats, (slots) => (slots.source.ref = "number/rounds-after")));

    expect(paperPublishEligibility(video, facts).issues[0]?.message).toBe("replot beat-02 cites no gathered figure; its source.ref must name a figure fact id");
  });
});
