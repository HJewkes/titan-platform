// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RoundNote } from "./RoundNote.js";

afterEach(cleanup);

describe("RoundNote", () => {
  it("keeps each line of a note as its own row and splits labels from values", () => {
    render(<RoundNote text={"WHAT: a jar\nWHY WAITING: the lid\nHEAD: 02ff. RECOMMENDATION: FIX."} />);
    expect(screen.getAllByTestId("round-note-row")).toHaveLength(4);
    expect(screen.getByText("WHY WAITING")).toBeTruthy();
    expect(screen.getByText("the lid")).toBeTruthy();
    expect(screen.getByText("RECOMMENDATION")).toBeTruthy();
    expect(screen.getByText("FIX.")).toBeTruthy();
  });

  it("shows plain text unchanged and a heading above the note", () => {
    render(<RoundNote heading="Changed" text="The lid now fits." />);
    expect(screen.getByText("Changed")).toBeTruthy();
    expect(screen.getByText("The lid now fits.")).toBeTruthy();
  });
});
