import { describe, expect, it } from "vitest";
import { l0HardPass } from "./eval-l0.js";
import { voiceCheck, voiceCheckWith } from "./lint-voice.js";
import { lint, tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const voice = (beats = withBeat("w1", {}), checks = [voiceCheck]) => lint(tour(beats), checks);
const spoken = (id: string, text: string, extra: Record<string, unknown> = {}) => withBeat(id, { spoken: text, extra });

describe("voice lints on the positive control", () => {
  it("passes every Q-V rule", () => {
    const rows = [...voice().values()];

    expect(rows.map((r) => r.check_id)).toEqual(["Q-V1", "Q-V2", "Q-V3", "Q-V4", "Q-V5", "Q-V7", "Q-V8", "Q-V9"]);
    expect(rows.filter((r) => !r.pass)).toEqual([]);
    expect(l0HardPass(rows)).toBe(true);
  });
});

describe("Q-V1 process narration", () => {
  it("counts each spoken sentence about how the repo was reviewed", () => {
    const beats = spoken("w2", "The review checked forty claims against the code. Every hop was traced by reading the source.");

    const row = voice(beats).get("Q-V1");

    expect(row).toMatchObject({ value: 2, pass: false, detail_beats: ["w2"] });
  });

  it("does not flag a repo part whose name holds a process word", () => {
    const beats = spoken("w2", "The agent hands each scan to the review server, which keeps it.", {
      visual: { assertion: "The review server keeps each scan", job: "numbers", labels: ["Review server"] },
    });

    expect(voice(beats).get("Q-V1")?.pass).toBe(true);
  });

  it("flags that part when nothing names it as a repo entity", () => {
    const beats = spoken("w2", "The agent hands each scan to the review server, which keeps it.");

    expect(voice(beats).get("Q-V1")?.detail_beats).toEqual(["w2"]);
  });

  it("masks entities a caller supplies from the repo's own names", () => {
    const beats = spoken("w2", "Four of the five files sit in the review package.");

    expect(voice(beats, [voiceCheckWith(["review package"])]).get("Q-V1")?.pass).toBe(true);
  });
});

describe("Q-V2 provenance placement", () => {
  it("flags a status word in a headline and an internal id in a label", () => {
    const beats = withBeat("w1", { extra: { visual: { assertion: "Runtime links (from review)", job: "numbers" } } }).map((spec) =>
      spec[0] === "w2" ? ([...spec.slice(0, 4), { visual: { assertion: "Links", job: "numbers", labels: ["D-PD-W1-011"] } }] as typeof spec) : spec,
    );

    expect(voice(beats).get("Q-V2")).toMatchObject({ value: 2, detail_beats: ["w1", "w2"] });
  });

  it("allows provenance inside a chip", () => {
    const visual = { assertion: "The desk refuses unknown parcels", job: "numbers", chips: [{ kind: "our-framing", text: "our framing · critique §3" }] };

    expect(voice(withBeat("w1", { extra: { visual } })).get("Q-V2")?.pass).toBe(true);
  });
});

describe("Q-V3 verdict placement", () => {
  it("flags a verdict tacked onto a content beat", () => {
    expect(voice(spoken("w2", "The desk server holds each scan. Adopt that.")).get("Q-V3")?.detail_beats).toEqual(["w2"]);
  });

  it("accepts a VERDICT beat after the chapter's last HOW", () => {
    const beats = [...withBeat("w1", {})];
    beats.splice(9, 0, ["v1", "ch3", "VERDICT", "Adopt the ledger check, because it keeps labels honest."]);

    expect(voice(beats).get("Q-V3")?.pass).toBe(true);
  });

  it("flags a VERDICT beat placed before the chapter's HOW", () => {
    const beats = [...withBeat("w1", {})];
    beats.splice(6, 0, ["v1", "ch3", "VERDICT", "Adopt the ledger check, because it keeps labels honest."]);

    expect(voice(beats).get("Q-V3")?.detail_beats).toEqual(["v1"]);
  });
});

describe("spoken register", () => {
  it("Q-V4 flags a spoken chapter number", () => {
    expect(voice(spoken("w1", "Chapter two. So every scan enters through the scanner app.")).get("Q-V4")?.detail_beats).toEqual(["w1"]);
  });

  it("Q-V5 fails when signposts and first-person sentences crowd out the project", () => {
    const beats = spoken("w2", "Here is the server. We think it matters. Our team likes it. Now titan.");

    expect(voice(beats).get("Q-V5")).toMatchObject({ pass: false, threshold: 0.8 });
  });

  it("Q-V7 flags banned register but not a value phrase that looks like it", () => {
    const banned = voice(spoken("w2", "Let's simply look. There is a ledger."));
    const allowed = voice(spoken("w2", "The ledger lets you trust each label."));

    expect(banned.get("Q-V7")?.value).toBe(2);
    expect(allowed.get("Q-V7")?.pass).toBe(true);
  });

  it("Q-V8 needs a pointing cue for a pointing phrase", () => {
    const text = "On the left, the scanner sends each scan to the desk.";
    const cue = { visual: { assertion: "The scanner feeds the desk", job: "numbers", cues: [{ action: "V6", target: "scanner", atCue: "left," }] } };

    expect(voice(spoken("w2", text)).get("Q-V8")?.detail_beats).toEqual(["w2"]);
    expect(voice(spoken("w2", text, cue)).get("Q-V8")?.pass).toBe(true);
  });

  it("Q-V9 flags a sentence over twenty-five words", () => {
    const long = `${Array.from({ length: 26 }, () => "scan").join(" ")}.`;

    expect(voice(spoken("w2", long)).get("Q-V9")).toMatchObject({ value: 1, detail_beats: ["w2"] });
  });
});
