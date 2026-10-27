import { describe, expect, it } from "vitest";
import type { QaGate } from "../qa/gate-profile.js";
import { fakeQa } from "../qa/qa-fakes.test-helpers.js";
import { qaGateWith } from "./qa-gate.js";

describe("render QA gate lead lines", () => {
  it("holds late-fill on a verdict card unless the timeline hints its lead line", async () => {
    // Arrange
    const bare = { id: "beat-01", kind: "verdict-card", startS: 0, durationS: 4, cues: { call: 3.9 } };
    const lateGate: QaGate = { sha: "e".repeat(64), gate: ["late-fill"], inspect: {} };
    const gate = qaGateWith(fakeQa({ contentRuns: 1 }));

    // Act
    const withoutHint = await gate("http://127.0.0.1:1/", { beats: [bare] }, lateGate);
    const withHint = await gate("http://127.0.0.1:1/", { beats: [{ ...bare, hints: { qaLeadLine: true } }] }, lateGate);

    // Assert
    expect(withoutHint.held.errors.map((held) => held.kind)).toContain("late-fill");
    expect(withHint.held.errors).toEqual([]);
  });
});
