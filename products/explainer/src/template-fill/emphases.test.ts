import { describe, expect, it } from "vitest";
import { fillSolo } from "./fill-fixtures.test-helpers.js";

const cue = (target: string, atCue: string) => ({ action: "V6", target, atCue });
/** Synthetic: an invented night desk, its two lanes and its crew. */
const SPOKEN = "The desk runs two lanes now, not one queue, and the crew covers the night shift.";

describe("template fill: emphasis on a later cue", () => {
  it("a row named again on a later cue lights on that word, and its own reveal lights nothing", () => {
    // Arrange
    const visual = { beat: "list", labels: ["tick Two lanes", "tick Night crew"], cues: [cue("rows-1", "lanes"), cue("rows-2", "crew"), cue("rows-1", "shift")] };

    // Act
    const found = fillSolo(visual, SPOKEN);

    // Assert
    expect(found.reveals).toEqual([{ target: "rows-1", atCue: "lanes" }, { target: "rows-2", atCue: "crew" }]);
    expect(found.emphases).toEqual([{ target: "rows-1", atCue: "shift" }]);
  });

  it("an arch-map edge cue lights the edge once both its ends have landed", () => {
    // Arrange
    const nodes = [cue("nodes-1", "desk"), cue("nodes-2", "lanes"), cue("nodes-3", "crew")];
    const visual = { beat: "arch-map", labels: ["Desk", "Lanes", "Crew"], cues: [...nodes, cue("edges-1", "covers"), cue("edges-2", "queue")] };

    // Act
    const found = fillSolo(visual, SPOKEN);

    // Assert
    expect(found.spec).toBe("arch-map");
    expect(found.emphases).toEqual([{ target: "edges-1", atCue: "covers" }]);
  });

  it("a cue on an element the slots do not hold lights nothing", () => {
    // Arrange
    const visual = { beat: "list", labels: ["tick Two lanes"], cues: [cue("rows-1", "lanes"), cue("rows-4", "crew")] };

    // Act
    const found = fillSolo(visual, SPOKEN);

    // Assert
    expect(found.emphases).toEqual([]);
  });
});
