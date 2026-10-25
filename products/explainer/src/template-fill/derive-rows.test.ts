import { describe, expect, it } from "vitest";
import { fill, filledBeat, fillSolo, fixtureScript } from "./fill-fixtures.test-helpers.js";

const cue = (target: string, atCue: string) => ({ action: "V6", target, atCue });

describe("template fill: list beats", () => {
  it("marks each row from its first word, takes a lane from `<lane> · <text>` and titles the rows with the chapter", () => {
    // Arrange
    const visual = { beat: "list", labels: ["tick Two lanes", "cross One queue", "crew · Night shift"], cues: [cue("rows-1", "lanes"), cue("rows-3", "night")] };

    // Act
    const found = fillSolo(visual);

    // Assert
    expect(found.slots).toEqual({
      title: "The refusal",
      rows: [
        { id: "rows-1", text: "Two lanes", mark: "tick" },
        { id: "rows-2", text: "One queue", mark: "cross" },
        { id: "rows-3", text: "Night shift", mark: "dot", lane: "crew" },
      ],
    });
  });

  it("lands each row on its numbered cue, and a row with no cue on the cue before it", () => {
    // Arrange
    const visual = { beat: "list", labels: ["tick Two lanes", "cross One queue", "crew · Night shift"], cues: [cue("rows-1", "lanes"), cue("rows-3", "night")] };

    // Act
    const found = fillSolo(visual);

    // Assert
    expect(found.reveals).toEqual([
      { target: "rows-1", atCue: "lanes" },
      { target: "rows-2", atCue: "lanes" },
      { target: "rows-3", atCue: "night" },
    ]);
  });

  it("lets the heading give way past three rows, and not at three", () => {
    // Arrange
    const three = { beat: "list", labels: ["tick One", "tick Two", "tick Three"] };
    const four = { beat: "list", labels: ["tick One", "tick Two", "tick Three", "tick Four"] };

    // Act
    const [atThree, atFour] = [fillSolo(three), fillSolo(four)];

    // Assert
    expect(atThree.hints.headingYields).toBeUndefined();
    expect(atFour.hints.headingYields).toBe(true);
  });

  it("shows the assertion as the one row when the beat has no labels", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "list", assertion: "Every scan waits for the ledger" });

    // Assert
    expect(found.slots.rows).toEqual([{ id: "rows-1", text: "Every scan waits for the ledger", mark: "dot" }]);
  });
});

describe("template fill: continuation beats", () => {
  it("keeps the lead's title and its last rows from the first word, then the beat's own rows", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b3");

    // Assert
    expect(found.slots).toEqual({
      title: "The refusal",
      rows: [
        { id: "held-2", text: "One queue", mark: "cross" },
        { id: "held-3", text: "Night shift", mark: "dot", lane: "crew" },
        { id: "rows-1", text: "Weekend backlog", mark: "open" },
      ],
    });
    expect(found.reveals).toEqual([
      { target: "held-2", atCue: "A" },
      { target: "held-3", atCue: "A" },
      { target: "rows-1", atCue: "backlog" },
    ]);
    expect(found.hints).toEqual({ continues: "b2" });
  });

  it("opens a fresh stage for a later beat of another spec", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b4");

    // Assert
    expect(found.spec).toBe("stat");
    expect(found.hints.continues).toBeUndefined();
  });

  it("reads every label of a verdict-card continuation as a reason under the held verdict", () => {
    // Arrange
    const script = fixtureScript();
    const lead = script.beats.find((beat) => beat.id === "b10")!;
    script.beats.splice(script.beats.indexOf(lead) + 1, 0, { ...lead, id: "b10b", spoken: "Night scans clear too.", visual: { ...lead.visual, labels: ["Night scans clear"], cues: [] } });

    // Act
    const found = filledBeat(fill(script), "b10b");

    // Assert
    expect(found.slots).toEqual({
      verdict: "Ship it: two lanes hold",
      call: "Ship it",
      reasons: [
        { id: "held-1", text: "Scans clear in minutes" },
        { id: "held-2", text: "No label prints early" },
        { id: "reasons-1", text: "Night scans clear" },
      ],
    });
  });
});

describe("template fill: verdict-card and issue-pin beats", () => {
  it("takes the call from the verdict's head and tells qa the verdict leads", () => {
    // Arrange
    const visual = { beat: "verdict-card", labels: ["Ship it: lanes hold", "Scans clear in minutes"] };

    // Act
    const found = fillSolo(visual);

    // Assert
    expect(found.slots).toEqual({ verdict: "Ship it: lanes hold", call: "Ship it", reasons: [{ id: "reasons-1", text: "Scans clear in minutes" }] });
    expect(found.hints.qaLeadLine).toBe(true);
  });

  it("falls back to a list when a verdict has no call and no chip", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "verdict-card", labels: ["Lanes hold", "Scans clear in minutes"] });

    // Assert
    expect(found.fallback).toEqual({ from: "verdict-card", reason: expect.stringContaining("no call") });
    expect(found.spec).toBe("list");
  });

  it("titles pinned issues by their node labels and lands each pin on its own cue", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b9");

    // Assert
    expect(found.slots).toEqual({
      title: "Desk server → Ledger",
      issues: [
        { id: "issues-1", title: "Desk server: holds scans", severity: "medium", pin: "desk-server" },
        { id: "issues-2", title: "Ledger: answers slowly", severity: "medium", pin: "ledger" },
      ],
    });
    expect(found.reveals).toEqual([
      { target: "issues-1", atCue: "holds" },
      { target: "issues-2", atCue: "slowly" },
    ]);
  });

  it("draws an issue-pin with no pins as a list of problems", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "issue-pin", labels: ["risk Slow ledger", "Late printer"] });

    // Assert
    expect(found.fallback?.from).toBe("issue-pin");
    expect(found.slots.rows).toEqual([
      { id: "rows-1", text: "Slow ledger", mark: "cross" },
      { id: "rows-2", text: "Late printer", mark: "cross" },
    ]);
  });
});
