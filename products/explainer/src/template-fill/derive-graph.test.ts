import { describe, expect, it } from "vitest";
import { FillError } from "./fill.js";
import { fill, filledBeat, fillSolo, fixtureScript, soloScript } from "./fill-fixtures.test-helpers.js";

describe("template fill: arch-map beats", () => {
  it("lays four labels out as a one-way path under the chapter title", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b6");

    // Assert
    expect(found.slots).toEqual({
      title: "The scan path",
      nodes: [
        { id: "nodes-1", label: "Scanner" },
        { id: "nodes-2", label: "Desk server" },
        { id: "nodes-3", label: "Ledger" },
        { id: "nodes-4", label: "Printer" },
      ],
      edges: [
        { id: "edges-1", from: "nodes-1", to: "nodes-2" },
        { id: "edges-2", from: "nodes-2", to: "nodes-3" },
        { id: "edges-3", from: "nodes-3", to: "nodes-4" },
      ],
    });
    expect(found.reveals.map((reveal) => reveal.atCue)).toEqual(["scanner", "desk", "ledger", "printer"]);
  });

  it("falls back to a list for one label: one node is not a path", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "arch-map", labels: ["Scanner"] });

    // Assert
    expect(found.fallback?.from).toBe("arch-map");
    expect(found.slots.rows).toEqual([{ id: "rows-1", text: "Scanner", mark: "dot" }]);
  });

  it("refuses six labels with no map_state, since the fallback list holds five rows", () => {
    // Arrange
    const script = soloScript({ beat: "arch-map", labels: ["A", "B", "C", "D", "E", "F"] });

    // Act
    const act = () => fill(script);

    // Assert
    expect(act).toThrow(FillError);
    expect(act).toThrow(/s1 \(arch-map: .*list fallback is invalid too/);
  });

  it("draws the script map's nodes in map_state reveal order, each on its reveal cue, with the focus renamed", () => {
    // Arrange
    const state = {
      level: "components",
      reveal: [
        { id: "ledger", atCue: "queue" },
        { id: "scanner", atCue: "night" },
      ],
      focus: { ids: ["scanner"], atCue: "night" },
    };

    // Act
    const found = fillSolo({ beat: "arch-map", map_state: state });

    // Assert
    expect(found.slots).toEqual({
      title: "The refusal",
      nodes: [
        { id: "nodes-1", label: "Ledger" },
        { id: "nodes-2", label: "Scanner" },
      ],
      edges: [],
      focus: "nodes-2",
    });
    expect(found.reveals).toEqual([
      { target: "nodes-1", atCue: "queue" },
      { target: "nodes-2", atCue: "night" },
    ]);
  });
});
