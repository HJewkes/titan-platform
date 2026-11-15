import { describe, expect, it } from "vitest";
import { dailyWith, dailyScript, l0Row } from "./daily-script.test-helpers.js";

const CHECK_ID = "Q-V19:term-spoken-shown";
// Twelve words over twelve planned seconds, so word n is spoken at second n: "warm" at 4 s, "store" at 5 s.
const SPOKEN = "Our lane keeps a warm store ready for the busy morning rush";
const cueOn = (atCue: string) => ({ action: "V6" as const, target: "rows-1", atCue });

function termBeat(over: { terms?: string[]; spoken?: string; labels?: string[]; cueWord?: string }) {
  return dailyWith("goals-1", {
    plannedS: 12,
    spoken: over.spoken ?? SPOKEN,
    new_terms: over.terms ?? ["warm store"],
    visual: { labels: over.labels ?? ["cache · Warm store"], cues: [cueOn(over.cueWord ?? "warm")] },
  });
}

describe("Q-V19 a declared term is spoken and shown together", () => {
  it("passes a term spoken, labelled and cued on its own word", () => {
    const script = termBeat({});

    const row = l0Row(script, CHECK_ID);

    expect(row).toMatchObject({ severity: "warning", pass: true, detail_beats: [] });
  });

  it("fails a term its beat never speaks", () => {
    const script = termBeat({ terms: ["cold shelf"], labels: ["cache · Cold shelf"] });

    const row = l0Row(script, CHECK_ID);

    expect(row).toMatchObject({ severity: "warning", pass: false, detail_beats: ["goals-1"] });
  });

  it("fails a term spoken but missing from the beat's labels and chips", () => {
    const script = termBeat({ labels: ["cache · Fresh shelf"] });

    const row = l0Row(script, CHECK_ID);

    expect(row).toMatchObject({ severity: "warning", pass: false, detail_beats: ["goals-1"] });
  });

  it("accepts a term shown in a chip instead of a label", () => {
    const base = termBeat({ labels: ["cache · Fresh shelf"] });
    const script = dailyWith("goals-1", { visual: { chips: [{ kind: "computed", text: "warm store" }] } }, base);

    const row = l0Row(script, CHECK_ID);

    expect(row.pass).toBe(true);
  });

  it("fails a term whose nearest cue lands 3 s from its first spoken word", () => {
    const script = termBeat({ cueWord: "for" });

    const row = l0Row(script, CHECK_ID);

    expect(row).toMatchObject({ severity: "warning", pass: false, detail_beats: ["goals-1"] });
  });

  it("passes a cue one second after the term's first word", () => {
    const script = termBeat({ cueWord: "store" });

    const row = l0Row(script, CHECK_ID);

    expect(row.pass).toBe(true);
  });

  it("passes a script whose beats declare no terms", () => {
    const script = dailyScript();

    const row = l0Row(script, CHECK_ID);

    expect(row).toMatchObject({ severity: "warning", pass: true, detail_beats: [] });
  });
});
