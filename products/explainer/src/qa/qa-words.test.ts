import { describe, expect, it } from "vitest";
import { resolvedFor, soloScript } from "../template-fill/fill-fixtures.test-helpers.js";
import { FULL_STAGE } from "./qa-fakes.test-helpers.js";
import { FROM, qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

describe("qa stage on-screen word gates", () => {
  it.each([
    ["words-per-frame", 21],
    ["headline-label-words", 11],
  ])("fails the stage on %s with a %i-word headline", async (check, n) => {
    const headline = Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const wordy = () => ({ ...FULL_STAGE, texts: [{ ...FULL_STAGE.texts[0]!, text: headline }] });

    const { report, checks } = await harness.run({ probeAt: wordy });

    expect(checks[check]).toMatchObject({ gate: true, pass: false });
    expect(report.pass).toBe(false);
  });

  /** One list beat (or code-walk beat) showing `display`, over narration that says "the parcel desk reads the row first". */
  async function shown(display: string, kind = "list") {
    const script = soloScript({ beat: "list", labels: ["tick Two lanes"] });
    const resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats: resolvedFor(script).beats, budgets: [] };
    const said = "the parcel desk reads the row first".split(" ").map((word, i) => ({ word, start: 0.5 + i * 0.3, end: 0.7 + i * 0.3 }));
    const words = { beats: [{ id: script.beats[0]!.id, startS: 0, durationS: 4, words: said }] };
    const timeline = { durationS: 4, beats: [{ id: "beat-01", kind, startS: 0, durationS: 4, slots: {} }] };
    const put = (value: unknown, as: string) => harness.store().putText(JSON.stringify(value), as, FROM);
    const extra = () => ({ script: put(script, "script"), resolved: put(resolved, "resolved"), words: put(words, "words") });
    const probe = () => ({ ...FULL_STAGE, texts: [{ ...FULL_STAGE.texts[0]!, tag: "span", cls: "tok", text: display }] });
    return harness.run({ probeAt: probe }, { timeline, extra });
  }

  it("fails the stage on narration-shared-run when the screen repeats 5 narration words", async () => {
    const { report, checks } = await shown("parcel desk reads the row");

    expect(checks["narration-shared-run"]).toMatchObject({ gate: true, pass: false });
    expect(report.pass).toBe(false);
  });

  it("passes words-per-frame on a code-walk beat whose highlighted lines run past 20 words", async () => {
    const code = Array.from({ length: 30 }, (_, i) => `t${i}`).join(" ");

    const prose = await shown(code);
    const walk = await shown(code, "code-walk");

    expect(prose.checks["words-per-frame"]).toMatchObject({ gate: true, pass: false });
    expect(walk.checks["words-per-frame"]).toMatchObject({ gate: true, pass: true });
  });
});
