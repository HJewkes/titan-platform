import { describe, expect, it } from "vitest";
import { decisionItems } from "./decisions-source.js";
import { dayWindow } from "./gather-daily.js";

/** Synthetic only: an invented decisions log for a made-up project. */
const LOG = [
  "# Decisions",
  "",
  "900. Owner 2030-01-01 ~23:4xZ (to the desk seat): \"Ship the scanner fix first\". Applied.",
  "901. Owner 2030-01-02 ~23:5xZ (live, to the desk seat): \"Hold the courier rollout until the pilot reports\".",
  "   1. Sub-item with no stamp, which is no decision of its own.",
  "902. Owner same time: \"Keep the old label printer as the fallback\".",
  "903. Owner 2030-01-02 ~18:3x MDT (live, to the desk seat): \"Move the night shift to the new desk\".",
  "904. Owner 2030-01-02T10:15:07Z, round desk-r1, approved the dashboard layout without a quote.",
  "905. Owner, on the backlog: no stamp at all.",
  "### 2030-01-02T12:00Z codex note, not a numbered decision",
  "",
].join("\n");

const JAN_2 = dayWindow("2030-01-02");

describe("daily decisions source over a synthetic decisions log", () => {
  it("keeps the numbered decisions stamped inside the UTC day, converting MDT and inheriting a same-time stamp", () => {
    const { items } = decisionItems(LOG, JAN_2);

    expect(items.map((item) => [item.id, item.at])).toEqual([
      ["decision/901", "2030-01-02T23:50:00.000Z"],
      ["decision/902", "2030-01-02T23:50:00.000Z"],
      ["decision/904", "2030-01-02T10:15:00.000Z"],
    ]);
  });

  it("places an MDT evening decision in the next UTC day", () => {
    const { items } = decisionItems(LOG, dayWindow("2030-01-03"));

    expect(items).toEqual([{ id: "decision/903", kind: "decision", title: "Move the night shift to the new desk", at: "2030-01-03T00:30:00.000Z", priority: "P1" }]);
  });

  it("titles a decision by its first quoted phrase, else by its opening text", () => {
    const { items } = decisionItems(LOG, JAN_2);

    expect(items.find((item) => item.id === "decision/901")?.title).toBe("Hold the courier rollout until the pilot reports");
    expect(items.find((item) => item.id === "decision/904")?.title).toBe("Owner 2030-01-02T10:15:07Z, round desk-r1, approved the dashboard layout without a quote.");
  });

  it("skips the undated entry with one note and never counts a sub-item or a heading", () => {
    const { items, notes } = decisionItems(LOG, JAN_2);

    expect(notes).toEqual(["decisions log: skipped 1 numbered entry with no date stamp"]);
    expect(items.some((item) => item.id === "decision/1" || item.id === "decision/905")).toBe(false);
  });
});
