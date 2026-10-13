import { describe, expect, it } from "vitest";
import { attributeFindings, type Finding } from "./attribute.js";

const BEAT_IDS = ["beat-01", "beat-03", "beat-30"];

const error = (selector: string, message = "text overflows the canvas"): Finding => ({
  code: "overflow",
  message,
  severity: "error",
  selector,
});

describe("attributeFindings", () => {
  it("maps a beat-03 selector to beat 3 and not to beat 30", () => {
    const finding = error("#beat-03 .title");

    const { byBeat, unattributed } = attributeFindings([finding], BEAT_IDS);

    expect([...byBeat.keys()]).toEqual(["beat-03"]);
    expect(byBeat.get("beat-03")).toEqual([finding]);
    expect(unattributed).toEqual([]);
  });

  it("maps a beat-30 selector to beat 30 even though beat-3 is its prefix", () => {
    const { byBeat } = attributeFindings([error("#beat-30 .chart")], BEAT_IDS);

    expect([...byBeat.keys()]).toEqual(["beat-30"]);
  });

  it("treats an unpadded beat-3 in a message as the same beat as beat-03", () => {
    const { byBeat } = attributeFindings([error("", "beat-3 has no motion between 1.0 s and 1.5 s")], BEAT_IDS);

    expect([...byBeat.keys()]).toEqual(["beat-03"]);
  });

  it("leaves a finding naming no known beat unattributed", () => {
    const unknown = error("#beat-07 .title");
    const anonymous = error(".caption-track");

    const { byBeat, unattributed } = attributeFindings([unknown, anonymous], BEAT_IDS);

    expect(byBeat.size).toBe(0);
    expect(unattributed).toEqual([unknown, anonymous]);
  });

  it("does not read a longer token such as beat-3x or rebeat-3 as a beat id", () => {
    const { unattributed } = attributeFindings([error("#beat-3x"), error("#rebeat-3")], BEAT_IDS);

    expect(unattributed).toHaveLength(2);
  });

  it("ignores warnings", () => {
    const warning: Finding = { ...error("#beat-01"), severity: "warning" };

    const { byBeat, unattributed } = attributeFindings([warning], BEAT_IDS);

    expect(byBeat.size).toBe(0);
    expect(unattributed).toEqual([]);
  });

  it("collects several findings for one beat in order", () => {
    const first = error("#beat-01 h1");
    const second = error("#beat-01 p");

    const { byBeat } = attributeFindings([first, second], BEAT_IDS);

    expect(byBeat.get("beat-01")).toEqual([first, second]);
  });
});
