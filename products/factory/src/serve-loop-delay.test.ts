import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@titan-design/daemon";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { startLoopDelayWatch, type LoopDelayHistogram } from "./serve-loop-delay.js";

vi.mock("node:perf_hooks", () => ({ monitorEventLoopDelay: vi.fn() }));

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

  it("warns when a block spans a window boundary and the reset drops the histogram's sample", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const watch = startLoopDelayWatch({ log, histogram: fakeHistogram(0) });
    vi.advanceTimersByTime(WINDOW_MS - 1_000);

    vi.setSystemTime(Date.now() + 6_000);
    vi.advanceTimersByTime(1_000);

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ maxMs: 6_000 }), "event loop stalled");
    watch.stop();
  });

  it("builds the default histogram at 20 ms resolution, enabling it on start and disabling it on stop", () => {
    vi.useFakeTimers();
    const histogram = fakeHistogram(0);
    vi.mocked(monitorEventLoopDelay).mockReturnValue(partialFake<ReturnType<typeof monitorEventLoopDelay>>(histogram));

    const watch = startLoopDelayWatch({ log: fakeLog() });

    expect(monitorEventLoopDelay).toHaveBeenCalledWith({ resolution: 20 });
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(histogram.disable).not.toHaveBeenCalled();
    watch.stop();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
  });
});
