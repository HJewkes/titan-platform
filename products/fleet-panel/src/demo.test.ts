import { describe, expect, it } from "vitest";
import { demoSnapshot } from "./demo.js";
import { NOW_MS, fixtureSnapshot } from "./fixture.js";
import { fleetView } from "./view-model.js";

const lines = (view: ReturnType<typeof fleetView>) => [...view.header, ...view.rows].map((line) => line.map((s) => s.text).join(""));

describe("demoSnapshot", () => {
  it("draws the same pane at any clock as the fixture does at its own", () => {
    const later = NOW_MS + 5 * 86_400_000;

    expect(lines(fleetView(demoSnapshot(later), later))).toEqual(lines(fleetView(fixtureSnapshot(), NOW_MS)));
  });
});
