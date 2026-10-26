// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RoundSummary } from "../../server/rounds.js";
import { RoundSetLinks } from "./RoundSetNav.js";
import { roundsInSet, setKeyOf, setPositionOf } from "./round-set.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

function valid(unit: string, round: number, updatedAt: string): RoundSummary {
  return { id: `${unit}-r${round}`, status: "sent", updatedAt, valid: true, unit, round, questions: 1, design: false, ship: false, recommendations: "shown" };
}

// Newest first, as rounds.list returns them; r2 was touched last, so mtime alone would misorder the set.
const rounds: RoundSummary[] = [
  valid("jar-lids", 2, "2026-03-04T00:00:00.000Z"),
  valid("jar-labels", 1, "2026-03-03T00:00:00.000Z"),
  valid("jar-lids", 3, "2026-03-02T00:00:00.000Z"),
  valid("jar-lids", 1, "2026-03-01T00:00:00.000Z"),
  { id: "jar-lids-r4", status: "open", updatedAt: null, valid: false, reason: "no round.json" },
  { id: "loose-shelf", status: "open", updatedAt: null, valid: false, reason: "no round.json" },
];

describe("a round's set", () => {
  it("is its unit, else the id before -rN, else none", () => {
    expect(rounds.map(setKeyOf)).toEqual(["jar-lids", "jar-labels", "jar-lids", "jar-lids", "jar-lids", null]);
  });

  it("runs in round order, not by modified time", () => {
    expect(roundsInSet(rounds, "jar-lids").map((round) => round.id)).toEqual(["jar-lids-r1", "jar-lids-r2", "jar-lids-r3", "jar-lids-r4"]);
  });

  it("gives each end of the set no step past it", () => {
    expect(setPositionOf(rounds, "jar-lids-r1")).toMatchObject({ index: 1, size: 4, prev: null, next: { id: "jar-lids-r2" } });
    expect(setPositionOf(rounds, "jar-lids-r4")).toMatchObject({ index: 4, prev: { id: "jar-lids-r3" }, next: null });
    expect(setPositionOf(rounds, "jar-labels-r1")).toMatchObject({ size: 1, prev: null, next: null });
  });

  it("is unknown for a round with no set or one the list does not hold", () => {
    expect(setPositionOf(rounds, "loose-shelf")).toBeNull();
    expect(setPositionOf(rounds, "jar-lids-r9")).toBeNull();
  });
});

describe("RoundSetLinks", () => {
  it("links the neighbours and the set, with its place in it", () => {
    render(<RoundSetLinks rounds={rounds} id="jar-lids-r2" />);
    expect(screen.getByText("← Prev: jar-lids-r1")).toBeTruthy();
    expect(screen.getByText("Next: jar-lids-r3 →")).toBeTruthy();
    fireEvent.click(screen.getByText("jar-lids · 2 of 4"));
    expect(window.location.hash).toBe("#/rounds?set=jar-lids");
  });

  it("disables the step past an end and hides the key hint for a set of one", () => {
    render(<RoundSetLinks rounds={rounds} id="jar-labels-r1" />);
    expect(screen.getByText("← Prev")).toBeTruthy();
    expect(screen.getByText("Next →")).toBeTruthy();
    expect(screen.queryByText("[ and ] step through the set")).toBeNull();
  });

  it("steps with [ and ] and stays put at an end", () => {
    render(<RoundSetLinks rounds={rounds} id="jar-lids-r1" />);
    fireEvent.keyDown(window, { key: "[" });
    expect(window.location.hash).toBe("");
    fireEvent.keyDown(window, { key: "]" });
    expect(window.location.hash).toBe("#/rounds/jar-lids-r2");
  });

  it("ignores [ and ] typed into a field or held with a modifier", () => {
    render(
      <>
        <RoundSetLinks rounds={rounds} id="jar-lids-r2" />
        <textarea aria-label="notes" />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("notes"), { key: "]" });
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(window.location.hash).toBe("");
  });

  it("renders nothing for a round with no set", () => {
    render(<RoundSetLinks rounds={rounds} id="loose-shelf" />);
    expect(screen.queryByTestId("round-set-nav")).toBeNull();
  });
});
