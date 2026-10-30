import { describe, expect, it } from "vitest";
import { NOW_MS, fixtureSnapshot } from "./fixture.js";
import { FEED_QUIET_MS, fleetView, type Line } from "./view-model.js";

const text = (line: Line | undefined) => (line ?? []).map((segment) => segment.text).join("");
const rowOf = (lines: Line[], name: string) => lines.find((line) => text(line).includes(name));

describe("fleetView", () => {
  it("heads the panel with live counts, slots and the snapshot's age", () => {
    const view = fleetView(fixtureSnapshot(), NOW_MS + 4_000);

    expect(text(view.header[0])).toBe("fleet 2 live · 1 detached · 1 exited  slots 3/12  as of 4s");
  });

  it("says the feed is quiet once its last snapshot is old, instead of showing it as current", () => {
    const view = fleetView(fixtureSnapshot(), NOW_MS + FEED_QUIET_MS + 60_000);

    expect(text(view.header[0])).toContain("feed quiet 2m");
  });

  it("shows a fresh account's windows with reset times, and a stale one's age in place of figures", () => {
    const view = fleetView(fixtureSnapshot(), NOW_MS);

    expect(text(view.header[1])).toBe("acct-a ·1 5h ███░░ 62% ↻1h20m 7d █░░░░ 21% ↻3d");
    expect(text(view.header[2])).toBe("acct-b ·1  STALE 18m");
    expect(text(view.header[3])).toBe("claude ·1  no reading");
  });

  it("draws one row per agent with model, account, status word, context and spend", () => {
    const { rows } = fleetView(fixtureSnapshot(), NOW_MS);

    expect(text(rowOf(rows, "builder-a"))).toBe("● builder-a        opus   acct-a   DONE      ███░░░  44%   $4.10");
    expect(text(rowOf(rows, "reviewer-b"))).toBe("● reviewer-b       sonnet acct-b   —         —                 —");
    expect(text(rowOf(rows, "fixer-d"))).toBe("○ fixer-d          opus   acct-a   BLOCKED   120k tok          —");
  });

  it("keeps a spend of ten dollars or more apart from the context cell", () => {
    const planner = text(rowOf(fleetView(fixtureSnapshot(), NOW_MS).rows, "planner-c"));

    expect(planner).toMatch(/71% +\$12\.50$/);
  });

  it("dims a context and spend reading the status line wrote long ago", () => {
    const planner = rowOf(fleetView(fixtureSnapshot(), NOW_MS).rows, "planner-c") ?? [];

    expect(planner.filter((segment) => /%|\$/.test(segment.text)).map((segment) => segment.tone)).toEqual(["dim", "dim"]);
  });

  it("follows each agent with its task, PR and report age", () => {
    const { rows } = fleetView(fixtureSnapshot(), NOW_MS);
    const detail = rows[rows.indexOf(rowOf(rows, "builder-a") ?? []) + 1];

    expect(text(detail)).toBe("  DEMO-12 · #41 · reported 3m ago");
  });

  it("draws agent-supplied strings without control characters, keeping columns aligned", () => {
    const snapshot = fixtureSnapshot(["roster: \u001b]0;owned\u0007broke"]);
    const builder = snapshot.agents.find((agent) => agent.name === "builder-a");
    if (builder === undefined) throw new Error("fixture lost builder-a");
    Object.assign(builder, { name: "evil\u001b[2Jname", task: "TASK\u009b31m-1\nx", model: "\u001b[5mopus" });

    const view = fleetView(snapshot, NOW_MS);
    const all = [...view.header, ...view.rows].flat().map((segment) => segment.text).join("");
    const row = text(rowOf(view.rows, "evil"));

    const controls = [...all].filter((char) => (char.codePointAt(0) ?? 0) <= 0x1f || /[\u007f-\u009f]/.test(char));
    expect(controls).toEqual([]);
    expect(row.startsWith("● evil[2Jname      opus   acct-a")).toBe(true);
    expect(all).toContain("TASK31m-1x");
    expect(all).toContain("! roster: ]0;ownedbroke");
  });

  it("puts each source error in the header", () => {
    const view = fleetView(fixtureSnapshot(["roster: broker down"]), NOW_MS);

    expect(view.header.at(-1)).toEqual([{ text: "! roster: broker down", tone: "bad" }]);
  });
});
