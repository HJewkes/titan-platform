import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, ERROR_KINDS } from "@titan-design/render-qa";
import { cueGate } from "./cue-gate.js";
import { forwardOnly } from "./forward-clock.js";
import type { QaTimeline } from "./qa-timeline.js";
import { fakeQa } from "./qa-fakes.test-helpers.js";

const TIMELINE: QaTimeline = { beats: [{ id: "b1", kind: "title", startS: 0, durationS: 4, cues: [] }] };
const GATE = { gate: [...ERROR_KINDS], inspect: {} };

describe("cue gate clock", () => {
  it("completes the inspect and probe passes over one page", async () => {
    const engine = fakeQa();

    const result = await cueGate(engine, "http://page/", TIMELINE, GATE, { sweep: true, probe: true });

    expect(engine.inspected).toEqual(engine.probed);
    expect(result.probed.map((moment) => moment.t)).toEqual(result.sampled.map((moment) => moment.t));
  });

  it("names the pass and both times when a seek would go back", async () => {
    const page = forwardOnly(await fakeQa().open("http://page/", DEFAULT_OPTIONS, []));
    await page.inspectAt(3.5, DEFAULT_OPTIONS);

    const back = page.probe([{ beat: "b1", t: 0 }]);

    await expect(back).rejects.toThrow("qa probe pass asked the page clock to go back from 3.5 s (inspect pass) to 0 s");
  });
});
