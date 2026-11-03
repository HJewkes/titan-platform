import { describe, expect, it } from "vitest";
import { fill, filledBeat, fillSolo, fixtureScript } from "./fill-fixtures.test-helpers.js";

const cue = (target: string, atCue: string) => ({ action: "V6", target, atCue });

describe("template fill: chart beats", () => {
  it("draws two day-named points as bars, commas stripped, revealed on the first bar's cue only", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b7");

    // Assert
    expect(found.slots).toEqual({
      kind: "bar",
      series: [
        { id: "series-1", label: "Mon", value: 4 },
        { id: "series-2", label: "Tue", value: 1200 },
      ],
    });
    expect(found.reveals).toEqual([{ target: "series-1", atCue: "Monday" }]);
  });

  it("each cued bar reveals on its own cue", () => {
    // Arrange
    const spoken = "North sorted three, south sorted five, and east sorted only two.";
    const visual = { beat: "chart", labels: ["north: 3", "south: 5", "east: 2"], cues: [cue("series-1", "North"), cue("series-3", "east")] };

    // Act
    const found = fillSolo(visual, spoken);

    // Assert
    expect(found.slots.kind).toBe("bar");
    expect(found.reveals).toEqual([
      { target: "series-1", atCue: "North" },
      { target: "series-3", atCue: "east" },
    ]);
  });

  it("draws three points whose names are not dates as bars", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "chart", labels: ["north: 3", "south: 5", "east: 2"] });

    // Assert
    expect(found.slots.kind).toBe("bar");
  });

  it("draws three ISO-dated points as a line titled by the chapter, each point on its cue and read as MM-DD", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b8");

    // Assert
    expect(found.slots).toEqual({
      kind: "line",
      title: "The scan path",
      series: [
        { id: "series-1", label: "01-03", value: 5 },
        { id: "series-2", label: "01-04", value: 7 },
        { id: "series-3", label: "01-05", value: 6 },
      ],
    });
    expect(found.reveals.map((reveal) => reveal.atCue)).toEqual(["five", "seven", "six"]);
  });

  it("falls back to a list when a label is not a `name: number` pair", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "chart", labels: ["north: 3", "south is busy"] });

    // Assert
    expect(found.fallback).toEqual({ from: "chart", reason: expect.stringContaining("name: number") });
  });
});

describe("template fill: stat and stakes beats", () => {
  it("reads a label's number, its percent unit and the rest as the figure's label", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "stat", labels: ["12 % faster", "1,500 scans a day"], cues: [cue("figures-2", "night")] });

    // Assert
    expect(found.slots).toEqual({
      figures: [
        { id: "figures-1", value: 12, unit: "%", label: "faster" },
        { id: "figures-2", value: 1500, label: "scans a day" },
      ],
    });
  });

  it("falls back to a list when a label carries no number", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "stat", labels: ["12 % faster", "much calmer"] });

    // Assert
    expect(found.fallback?.from).toBe("stat");
    expect(found.spec).toBe("list");
  });

  it("states the cost as the assertion and keeps only the numeric labels as figures", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "stakes", assertion: "Every lost label costs a courier a trip", labels: ["3 trips a week", "angry couriers"] });

    // Assert
    expect(found.slots).toEqual({ cost: "Every lost label costs a courier a trip", figures: [{ id: "figures-1", value: 3, label: "trips a week" }] });
  });
});

describe("template fill: stat beats", () => {
  it("keeps a flush currency sign or version v with its number, not in the label", () => {
    // Arrange
    const visual = { beat: "stat", labels: ["Spend: $1261", "Per unit: $13.41", "Table: v1", "Shipped: 4,821"], cues: [] };

    // Act
    const found = fillSolo(visual, "Spend was high, a unit cost little, the table is new, and we shipped plenty.");

    // Assert
    expect(found.slots["figures"]).toEqual([
      { id: "figures-1", label: "Spend:", prefix: "$", value: 1261 },
      { id: "figures-2", label: "Per unit:", prefix: "$", value: 13.41 },
      { id: "figures-3", label: "Table:", prefix: "v", value: 1 },
      { id: "figures-4", label: "Shipped:", value: 4821 },
    ]);
  });
});
