import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { dailyKindBeats } from "./kinds-fixture.test-helpers.js";
import { kindsTimeline } from "./page.test-helpers.js";
import { registeredKinds } from "./registry.js";

/** The fixture's hand-written beats before the daily ones: the two page kinds, held and the two table kinds, which no daily script fills. */
const HAND_WRITTEN = ["opening", "pause", "showcase", "metrics", "scorecard"];
/** Hand-written beats after the daily ones: finding-card, which the template fill cannot derive from labels. */
const TRAILING = ["findings"];

describe("fixtures/kinds.timeline.json", () => {
  test("its daily beats are what the template fill makes of the synthetic daily script", () => {
    const { beats } = kindsTimeline();
    const daily = beats.filter((beat) => ![...HAND_WRITTEN, ...TRAILING].includes(beat.id));
    const handEnd = Math.max(...beats.filter((beat) => HAND_WRITTEN.includes(beat.id)).map((beat) => beat.startS + beat.durationS));

    const filled = dailyKindBeats(handEnd);

    assert.deepEqual(daily, filled);
  });

  test("it holds a beat of every registered kind, so the sheet shows each one", () => {
    const kinds = new Set(kindsTimeline().beats.map((beat) => beat.kind));

    const missing = registeredKinds().filter((kind) => !kinds.has(kind));

    assert.deepEqual(missing, []);
  });
});
