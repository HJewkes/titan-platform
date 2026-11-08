import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@titan-design/daemon";
import { startLoopDelayWatch, type LoopDelayHistogram } from "./serve-loop-delay.js";

const WINDOW_MS = 60_000;

function fakeLog() {
  return { info: vi.fn<Logger["info"]>(), warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() };
}

function fakeHistogram(maxNs: number, p99Ns = 1e7) {
  const histogram = {
    max: maxNs,
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    reset: vi.fn(() => {
      histogram.max = 0;
    }),
    percentile: vi.fn(() => p99Ns),
  };
  return histogram satisfies LoopDelayHistogram;
}

describe("startLoopDelayWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns with p99Ms and maxMs when a window's max passes 5 s", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const watch = startLoopDelayWatch({ log, histogram: fakeHistogram(6e9) });

    vi.advanceTimersByTime(WINDOW_MS);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ p99Ms: 10, maxMs: 6000, windowMs: WINDOW_MS }, "event loop stalled");
    watch.stop();
  });

  it("stays quiet when a window's max is under 5 s", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const watch = startLoopDelayWatch({ log, histogram: fakeHistogram(4e9) });

    vi.advanceTimersByTime(WINDOW_MS);

    expect(log.warn).not.toHaveBeenCalled();
    watch.stop();
  });

  it("resets every window so a quiet window after a stall does not warn again", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const histogram = fakeHistogram(6e9);
    const watch = startLoopDelayWatch({ log, histogram });

    vi.advanceTimersByTime(WINDOW_MS * 2);

    expect(histogram.reset).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("stop disables the histogram and clears the timer", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const histogram = fakeHistogram(6e9);
    const watch = startLoopDelayWatch({ log, histogram });

    watch.stop();
    vi.advanceTimersByTime(WINDOW_MS * 3);

    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("honours custom thresholdMs and windowMs when the histogram records a stall mid-window", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const histogram = fakeHistogram(0);
    const watch = startLoopDelayWatch({ log, histogram, thresholdMs: 100, windowMs: 400 });

    vi.advanceTimersByTime(399);
    histogram.max = 300e6;
    vi.advanceTimersByTime(1);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ p99Ms: 10, maxMs: 300, windowMs: 400 }, "event loop stalled");
    watch.stop();
  });
});
