// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FLIP_MS, SequenceFigure } from "./FrameSequence.js";
import type { StillSequence } from "./progress-stills-heuristic.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sequence: StillSequence = {
  base: "count",
  steps: [
    { key: "count-p0", progress: 0, label: "0" },
    { key: "count-p0_5", progress: 0.5, label: "0.5" },
    { key: "count-p1", progress: 1, label: "1" },
  ],
};
const labels = new Map([
  ["count-p0", "Count at 0"],
  ["count-p0_5", "Count at 0.5"],
  ["count-p1", "Count at 1"],
]);

function renderSequence(): void {
  render(<SequenceFigure sequence={sequence} labels={labels} pinnable={() => true} header={(label) => <h3>{label}</h3>} renderStep={(key, label) => <p>{`${key} drawn as ${label}`}</p>} testID="viewer" />);
}

const shownStep = (): string | null => screen.getByTestId("sequence-shown-step").textContent;
const heading = (): string | null => screen.getByRole("heading").textContent;
const press = (name: string | RegExp): void => {
  fireEvent.click(screen.getByRole("button", { name }));
};

describe("a motion's stills in one viewer", () => {
  it("shows the first still alone, every other kept hidden in place", () => {
    renderSequence();

    expect(shownStep()).toBe("count-p0 drawn as Count at 0");
    expect(heading()).toBe("Count at 0");
    expect(screen.getAllByText(/drawn as/).filter((still) => still.closest("[aria-hidden]") === null)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Previous step of count" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("steps with Next and Prev, and the heading names the still shown", () => {
    renderSequence();

    press("Next step of count");
    expect(shownStep()).toBe("count-p0_5 drawn as Count at 0.5");
    expect(heading()).toBe("Count at 0.5");
    press("Next step of count");
    expect(shownStep()).toMatch(/^count-p1/);
    expect(screen.getByRole("button", { name: "Next step of count" }).getAttribute("aria-disabled")).toBe("true");
    press("Previous step of count");

    expect(shownStep()).toMatch(/^count-p0_5/);
  });

  it("scrubs to a step, and a button per progress value jumps to its still", () => {
    renderSequence();
    const scrubber = screen.getByRole("slider", { name: "Scrub count" });

    fireEvent.change(scrubber, { target: { value: "2" } });
    expect(shownStep()).toMatch(/^count-p1/);
    expect(scrubber.getAttribute("aria-valuetext")).toBe("progress 1");
    press("Step to progress 0.5");

    expect(shownStep()).toMatch(/^count-p0_5/);
    expect(screen.getByRole("button", { name: "Step to progress 0.5" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("plays only once Play is pressed, then flips through every still and loops back to the first", () => {
    vi.useFakeTimers();
    renderSequence();

    act(() => vi.advanceTimersByTime(FLIP_MS * 3));
    expect(shownStep()).toMatch(/^count-p0 /);
    press("Play");
    act(() => vi.advanceTimersByTime(FLIP_MS));
    expect(shownStep()).toMatch(/^count-p0_5/);
    act(() => vi.advanceTimersByTime(FLIP_MS));
    expect(shownStep()).toMatch(/^count-p1/);
    act(() => vi.advanceTimersByTime(FLIP_MS));

    expect(shownStep()).toMatch(/^count-p0 /);
  });

  it("stops playing on Pause or on a manual step", () => {
    vi.useFakeTimers();
    renderSequence();
    press("Play");
    act(() => vi.advanceTimersByTime(FLIP_MS));
    press("Pause");
    act(() => vi.advanceTimersByTime(FLIP_MS * 2));
    expect(shownStep()).toMatch(/^count-p0_5/);
    press("Play");

    press("Next step of count");
    act(() => vi.advanceTimersByTime(FLIP_MS * 2));

    expect(shownStep()).toMatch(/^count-p1/);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });
});
