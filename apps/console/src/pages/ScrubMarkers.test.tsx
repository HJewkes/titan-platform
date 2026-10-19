// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScrubMarkers } from "./ScrubMarkers.js";

afterEach(cleanup);

const marker = (id: string, atS: number, current = true) => ({ id, atS, current });

describe("scrub markers", () => {
  it("places a note at 50 s of a 200 s video a quarter of the way along", () => {
    render(<ScrubMarkers notes={[marker("n1", 50)]} duration={200} seek={() => undefined} />);
    expect(screen.getByTestId("theater-marker-n1").style.left).toBe("25%");
  });

  it("seeks to a note's time when its tick is tapped", () => {
    const seek = vi.fn();
    render(<ScrubMarkers notes={[marker("n1", 50), marker("n2", 150.5)]} duration={200} seek={seek} />);
    fireEvent.click(screen.getByLabelText("Seek to 2:30"));
    expect(seek).toHaveBeenCalledWith(150.5);
  });

  it("draws no tick for a note on an earlier render, and pins one past the end to the end", () => {
    render(<ScrubMarkers notes={[marker("old", 20, false), marker("late", 260)]} duration={200} seek={() => undefined} />);
    expect(screen.queryByTestId("theater-marker-old")).toBeNull();
    expect(screen.getByTestId("theater-marker-late").style.left).toBe("100%");
  });

  it("draws nothing until the duration is known", () => {
    render(<ScrubMarkers notes={[marker("n1", 50)]} duration={Number.NaN} seek={() => undefined} />);
    expect(screen.queryByTestId("theater-markers")).toBeNull();
  });
});
