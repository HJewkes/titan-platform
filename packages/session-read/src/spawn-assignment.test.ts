import { describe, expect, it } from "vitest";
import { assignedTaskIds, orientationEnd } from "./spawn-assignment.js";

/** Synthetic briefs shaped like agent-chat's orientation block; every id and name is invented. */
const HEADER = [
  '# Orientation: active-work initiative "demo"',
  "",
  "Injected automatically by `agent_spawn`. Treat the assignment below it as the actual task.",
].join("\n");

const OPEN_TASKS = [
  "## Open tasks (25, highest priority first)",
  "",
  ...Array.from({ length: 25 }, (_, index) => `- TP-${index + 1}: open task ${index + 1}, with a title long enough to fill the list`),
].join("\n");

const BRIEF_SECTION = `## Brief (brief.md)\n\nThe initiative ships the widget; see TP-2 for the origin. ${"Background prose. ".repeat(40)}`;
const RELATED = '## Related to this assignment (1, ranked; open with Read)\n\n- CC-9 "a related note" /redacted/notes/cc-9.md';

function orientation(...sections: string[]): string {
  return [HEADER, ...sections].join("\n\n");
}

function known(...ids: string[]): (id: string) => boolean {
  const set = new Set(ids);
  return (id) => set.has(id);
}

const everyId = (_id: string) => true;

function assign(brief: string, agentName = "impl-worker", isKnown = everyId) {
  return assignedTaskIds({ agentName, brief, isKnown });
}

describe("assignedTaskIds", () => {
  it("links only the assigned task when the orientation lists 25 open tasks and a related section", () => {
    const brief = [orientation(BRIEF_SECTION, OPEN_TASKS, RELATED), "TASK: TP-31 add the widget"].join("\n\n");

    expect(assign(brief)).toEqual({ taskIds: ["TP-31"], source: "brief-anchor" });
  });

  it("starts the assignment after the truncation marker when the session note is last", () => {
    const session = "## Most recent session (2026-09-20.md)\n\nPicked up TP-5 and left it half done\n… (truncated)\n\nEarlier sessions on disk: a.md, b.md";
    const brief = [orientation(OPEN_TASKS, session), "Build the exporter described in TP-40 next, then stop."].join("\n\n");

    expect(assign(brief)).toEqual({ taskIds: ["TP-40"], source: "brief-paragraph" });
  });

  it("prefers the name when name and brief disagree", () => {
    const result = assign("TASK: TP-423 the follow-up", "factory-tp422");

    expect(result).toEqual({ taskIds: ["TP-422"], source: "name-over-brief" });
  });

  it("reports the name source when the brief agrees or names nothing", () => {
    expect(assign("TASK: TP-422 the widget", "factory-tp422").source).toBe("name");
    expect(assign("no ids here", "factory-tp422").source).toBe("name");
  });

  it("reads hyphenated and glued name forms but rejects glued one-letter prefixes", () => {
    const ids = (agentName: string) => assign("", agentName).taskIds;

    expect(ids("tp-407-impl")).toEqual(["TP-407"]);
    expect(ids("cc137-s2")).toEqual(["CC-137"]);
    expect(ids("c-83-fix")).toEqual(["C-83"]);
    expect(ids("sm-t22-episodes")).toEqual([]);
    expect(ids("docs-dash-s4")).toEqual([]);
  });

  it("links both ids of a name that holds two", () => {
    expect(assign("", "plan-tp407-tp409").taskIds).toEqual(["TP-407", "TP-409"]);
  });

  it("links both ids of a two-task anchor and ignores parenthesised references", () => {
    const result = assign("TASK: plans for TP-407 and TP-409 (see TP-108)");

    expect(result).toEqual({ taskIds: ["TP-407", "TP-409"], source: "brief-anchor" });
  });

  it("treats more than three anchor ids as a list", () => {
    const brief = "Some context without ids.\n\nTASK: TP-1, TP-2, TP-3 and TP-4";

    expect(assign(brief)).toEqual({ taskIds: [], source: "none" });
  });

  it("counts parenthesised ids toward the anchor list cap", () => {
    expect(assign("TASK: TP-1 and TP-2 (after TP-3, TP-4)").source).toBe("none");
  });

  it("ignores ids the store does not know", () => {
    const result = assign("TASK: VMCP-07 docs", "impl-worker", known("TP-1"));

    expect(result).toEqual({ taskIds: [], source: "none" });
  });

  it("uses parenthesised anchor ids only when no id of any kind sits outside", () => {
    expect(assign("TASK: the docs pass (TP-5)").taskIds).toEqual(["TP-5"]);
    expect(assign("TASK: VMCP-07 docs (see TP-5)", "impl-worker", known("TP-5"))).toEqual({ taskIds: [], source: "none" });
  });

  it("links nothing when the orientation's end cannot be found", () => {
    const brief = [orientation(BRIEF_SECTION, OPEN_TASKS), "Build the exporter for TP-40."].join("\n\n");

    expect(assign(brief)).toEqual({ taskIds: [], source: "none" });
  });

  it("reads a brief with Windows line endings", () => {
    const brief = [orientation(BRIEF_SECTION, OPEN_TASKS, RELATED), "TASK: TP-31 add the widget"].join("\n\n").replace(/\n/g, "\r\n");

    expect(assign(brief)).toEqual({ taskIds: ["TP-31"], source: "brief-anchor" });
  });

  it("links nothing for an empty brief and an empty name", () => {
    expect(assign("", "")).toEqual({ taskIds: [], source: "none" });
  });

  it("does not shorten an id that the paragraph window cuts in two", () => {
    const brief = `${"x ".repeat(748)}TP-4012 is the task`;

    expect(assign(brief, "impl-worker", known("TP-4", "TP-40", "TP-401")).taskIds).toEqual([]);
  });

  it("finishes a hostile 100 KB brief well under 50 ms", () => {
    const shapes = [
      orientation(`## Open tasks\n\n${"- A-1 ".repeat(17_000)}`),
      orientation(RELATED, "- ".repeat(50_000)),
      `TASK: ${"A-1".repeat(34_000)}`,
      `${HEADER}${"(".repeat(100_000)}`,
    ];
    for (const brief of shapes) {
      const started = performance.now();
      assign(brief, "x".repeat(1_000));
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe("orientationEnd", () => {
  it("returns zero for a brief without an orientation block", () => {
    expect(orientationEnd("TASK: TP-1")).toBe(0);
  });

  it("treats an orientation header after leading whitespace as an orientation", () => {
    const brief = `\n  ${orientation(RELATED)}\n\nTASK: TP-31`;

    expect(brief.slice(orientationEnd(brief) ?? 0)).toBe("TASK: TP-31");
  });

  it("starts after the related list when the related heading is last", () => {
    const brief = `${orientation(OPEN_TASKS, RELATED)}\n\nAssignment text`;

    expect(brief.slice(orientationEnd(brief) ?? 0)).toBe("Assignment text");
  });
});
