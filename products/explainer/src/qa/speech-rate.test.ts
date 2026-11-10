import { describe, expect, it } from "vitest";
import { BEAT_MAX_WPM, OVERALL_WPM_BAND, speechRateReport, speechRateSummary } from "./speech-rate.js";

describe("speech rate", () => {
  it("flags a beat over the per-beat limit and names it", () => {
    const report = speechRateReport([{ id: "fast", words: 30, durationS: 6 }, { id: "calm", words: 28, durationS: 10 }]);
    expect(report.beats[0]).toMatchObject({ wpm: 300, fast: true });
    expect(report.fastBeats).toEqual(["fast"]);
    expect(BEAT_MAX_WPM).toBe(250);
  });

  it("marks a slow overall rate as outside the band", () => {
    const report = speechRateReport([{ id: "a", words: 20, durationS: 12 }, { id: "b", words: 20, durationS: 12 }]);
    expect(report.overallWpm).toBe(100);
    expect(report.overallInBand).toBe(false);
    expect(speechRateSummary(report)).toContain("OUTSIDE 150-190");
  });

  it("passes an in-range video with no fast beat", () => {
    const report = speechRateReport([{ id: "a", words: 30, durationS: 10 }, { id: "b", words: 29, durationS: 10 }]);
    expect(report.overallWpm).toBe(177);
    expect(report.overallInBand).toBe(true);
    expect(report.fastBeats).toEqual([]);
    expect(OVERALL_WPM_BAND).toEqual({ min: 150, max: 190 });
    expect(speechRateSummary(report)).toBe("speech rate: 177 wpm overall (in 150-190); no beat over 250 wpm");
  });

  it("gives a zero-duration beat no rate and leaves it out of the overall", () => {
    const report = speechRateReport([{ id: "empty", words: 12, durationS: 0 }, { id: "a", words: 30, durationS: 10 }]);
    expect(report.beats[0]).toMatchObject({ wpm: null, fast: false });
    expect(report.overallWpm).toBe(180);
  });

  it("reports no voiced beats when nothing has a duration", () => {
    const report = speechRateReport([{ id: "empty", words: 0, durationS: 0 }]);
    expect(report.overallWpm).toBeNull();
    expect(report.overallInBand).toBe(false);
    expect(speechRateSummary(report)).toBe("speech rate: no voiced beats");
  });
});
