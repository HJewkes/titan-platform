import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoWeekWindow, writeWeekly } from "./weekly.js";

const BOOTSTRAP_TURN = [
  "# Open loops (2 hanging)",
  "- [3d] Ship the audit plan.",
  '    see: source:codewatch/codewatch-audit-plan.md "Codewatch audit plan"',
  '    see: task:CW-12 "Audit runners"',
  "- [1d] Reconcile the archive.",
  '    see: [from `health`] note:health/2026-09-01-a-claim.md "A claim"',
].join("\n");

const SPAWN_TURN = [
  "## Related to this assignment (2, ranked; open with Read)",
  "",
  '- source:titan-platform/design.md "Design"',
  '- note:titan-platform/2026-09-23-sections.md "Sections"',
].join("\n");

const user = (timestamp: string, content: string) => ({ type: "user", timestamp, message: { content } });
const tool = (timestamp: string, name: string, input: object) => ({
  type: "assistant",
  timestamp,
  message: { content: [{ type: "tool_use", name, input }] },
});

describe("isoWeekWindow", () => {
  it("runs Monday 00:00 UTC to the next Monday", () => {
    expect(isoWeekWindow("2026-W46")).toEqual({ since: "2026-11-09T00:00:00.000Z", until: "2026-11-16T00:00:00.000Z" });
  });

  it("puts week 1 of a year that starts mid-week on the Monday before January 1", () => {
    expect(isoWeekWindow("2026-W01").since).toBe("2025-12-29T00:00:00.000Z");
  });

  it("rejects a malformed or out-of-range week", () => {
    for (const bad of ["2026-46", "2026-W5", "2026-W00", "2026-W54", "26-W46", "2026-w46"]) {
      expect(() => isoWeekWindow(bad)).toThrow(/--week must look like/);
    }
  });
});

describe("writeWeekly", () => {
  let dir: string;
  let activeRoot: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "weekly-"));
    activeRoot = path.join(dir, "active");
    out = path.join(dir, "state", "weekly.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function transcript(name: string, records: object[]): string {
    const file = path.join(dir, `${name}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"));
    return file;
  }

  const lines = () =>
    readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  function fixtureFiles(): string[] {
    return [
      transcript("inside-bootstrap", [
        user("2026-11-10T10:00:00Z", BOOTSTRAP_TURN),
        tool("2026-11-10T10:01:00Z", "Read", { file_path: "/root/codewatch/sources/codewatch-audit-plan.md" }),
        tool("2026-11-10T10:02:00Z", "mcp__active-work__active__search", { query: "x" }),
      ]),
      transcript("inside-spawn", [user("2026-11-12T08:00:00Z", SPAWN_TURN), tool("2026-11-12T08:01:00Z", "Read", { file_path: "/a" })]),
      transcript("before", [
        user("2026-11-08T23:59:59Z", BOOTSTRAP_TURN),
        tool("2026-11-08T23:59:59Z", "mcp__active-work__active__search", {}),
      ]),
      transcript("after", [
        user("2026-11-16T00:00:00Z", SPAWN_TURN),
        tool("2026-11-16T00:00:00Z", "mcp__active-work__active__search", {}),
      ]),
    ];
  }

  it("counts only activity between Monday and the next Monday", async () => {
    await writeWeekly({ week: "2026-W46", out, files: fixtureFiles(), activeRoot });

    expect(lines()).toEqual([
      {
        week: "2026-W46",
        triggers: {
          bootstrap: { served: 3, opened: 1, ratio: 1 / 3 },
          spawn: { served: 2, opened: 0, ratio: 0 },
        },
        recallSessionShare: 0.5,
      },
    ]);
  });

  it("leaves one line for a week that is run twice and keeps the other weeks", async () => {
    const files = fixtureFiles();
    await writeWeekly({ week: "2026-W45", out, files: [], activeRoot });
    await writeWeekly({ week: "2026-W46", out, files, activeRoot });
    await writeWeekly({ week: "2026-W46", out, files, activeRoot });

    expect(lines().map((row) => row.week)).toEqual(["2026-W45", "2026-W46"]);
  });

  it("writes zeros for a week with no activity", async () => {
    await writeWeekly({ week: "2026-W30", out, files: fixtureFiles(), activeRoot });

    expect(lines()).toEqual([
      {
        week: "2026-W30",
        triggers: {
          bootstrap: { served: 0, opened: 0, ratio: 0 },
          spawn: { served: 0, opened: 0, ratio: 0 },
        },
        recallSessionShare: 0,
      },
    ]);
  });
});
