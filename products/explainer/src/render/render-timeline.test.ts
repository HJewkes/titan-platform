import { describe, expect, it } from "vitest";
import { StoryboardSchema } from "../storyboard.js";
import { compileTimeline } from "./compile-timeline.js";
import { mixDurationS, type RenderTimeline } from "./render-video.js";

const board = StoryboardSchema.parse({
  video_type: "sample-type",
  title: "A synthetic board",
  beats: [
    { id: "beat-01", type: "hook", duration_s: 2, spoken: "A synthetic opening.", slots: { line: "Opening" } },
    { id: "beat-02", type: "outro", duration_s: 3, spoken: "A synthetic close.", slots: { line: "Close" } },
  ],
});

describe("compileTimeline's Timeline as render reads it", () => {
  it("is assignable to RenderTimeline, so a renamed timeline field fails the type check", () => {
    const timeline: RenderTimeline = compileTimeline(board);

    expect(mixDurationS(timeline)).toBe(timeline.durationS);
    expect(timeline.provisional).toBe(true);
  });
});
