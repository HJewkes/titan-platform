import { describe, expect, it } from "vitest";
import type { AdoptionOpportunity } from "./insights/adoption-registry.js";
import { patternId } from "./insights/post-filter.js";
import type { AdoptionRow, ToolAdoptionReport } from "./insights/tool-adoption.js";
import type { ToolGapRow, ToolGapsReport } from "./insights/tool-gaps.js";
import { diffWeeks, planTaskActions, renderDigest, trackedPatterns, type WeekSnapshot } from "./tool-gap-weekly.js";

const gap = (head: string, pattern: string, calls: number, sessions: number): ToolGapRow => ({
  patternId: patternId(pattern), head, pattern, stages: pattern.split(" | "), calls, sessions, agents: 3, outputChars: 100, status: "NEW", existingFlags: [],
});

const gapsReport = (patterns: ToolGapRow[]): ToolGapsReport => ({
  window: { since: "2026-10-04T00:00:00Z", until: "2026-10-11T00:00:00Z" },
  totals: { bashCalls: 500, skippedByHeads: 0, unreadable: 0, pipelines: 200, patterns: patterns.length, sessions: 40 },
  patterns,
});

const adoptionRow = (id: string, flags: AdoptionRow["flags"], daysSinceShip: number): AdoptionRow => ({
  id, row: 1, status: "shipped", task: "DEMO-1", pr: "demo/cli#1", shipped: "2026-09-01T00:00:00Z", newForm: `agent-chat ${id} --brief`,
  oldHead: `agent-chat ${id}`, oldPatterns: [], newUses: flags.includes("unused") ? 0 : 4, oldUses: 9, weeks: [], daysSinceShip, watching: false, flags, note: null,
});

const adoptionReport = (opportunities: AdoptionRow[]): ToolAdoptionReport => ({
  window: { since: "2026-10-04T00:00:00Z", until: "2026-10-11T00:00:00Z" },
  totals: { bashCalls: 500, skippedByHeads: 0, unreadable: 0, opportunities: opportunities.length },
  opportunities,
});

const week = (patterns: ToolGapRow[], opportunities: AdoptionRow[] = []): WeekSnapshot => ({ gaps: gapsReport(patterns), adoption: adoptionReport(opportunities) });

const REGISTRY: AdoptionOpportunity[] = [{
  id: "status-brief", row: 1, status: "baseline", task: null,
  old: { head: "agent-chat seats status", patterns: ["| head"] }, new: { head: "agent-chat seats status", flags: ["--brief"] },
}];

describe("planTaskActions", () => {
  it("files exactly one task for an untracked pattern above the threshold with no open task", () => {
    const actions = planTaskActions([gap("agent-chat agent ls", "| grep -E", 80, 12)], trackedPatterns(REGISTRY), []);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "add", patternId: patternId("| grep -E") });
    expect(actions[0]!.kind === "add" && actions[0]!.tags).toEqual(["tool-gap", `tool-gap:${patternId("| grep -E")}`, "item-114"]);
  });

  it("notes the open task tagged with the pattern id instead of filing a second one", () => {
    const id = patternId("| grep -E");
    const open = [{ id: "TP-9001", tags: ["tool-gap", `tool-gap:${id}`] }];

    const actions = planTaskActions([gap("agent-chat agent ls", "| grep -E", 80, 12)], new Set(), open);

    expect(actions).toEqual([expect.objectContaining({ kind: "note", patternId: id, taskId: "TP-9001" })]);
  });

  it("plans one action when the same pattern clears the threshold after two heads", () => {
    const rows = [gap("agent-chat agent ls", "| tail", 60, 11), gap("titan-factory shepherd timeline", "| tail", 70, 15)];

    const actions = planTaskActions(rows, new Set(), []);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind === "add" && actions[0]!.title).toContain("titan-factory shepherd timeline");
  });

  it("plans nothing for a registry pattern or a pattern below either threshold", () => {
    const rows = [gap("agent-chat seats status", "| head", 400, 40), gap("gh pr view", "| jq -r", 49, 30), gap("gh run view", "| grep", 300, 9)];

    expect(planTaskActions(rows, trackedPatterns(REGISTRY), [])).toEqual([]);
  });

  it("honours an overridden threshold", () => {
    const actions = planTaskActions([gap("gh pr view", "| jq -r", 5, 2)], new Set(), [], { minCalls: 5, minSessions: 2 });

    expect(actions).toHaveLength(1);
  });
});

describe("diffWeeks", () => {
  it("reports every row as new on a first run with no previous week", () => {
    const rows = [gap("gh pr view", "| jq -r", 60, 11), gap("gh run view", "| grep", 20, 3)];

    const diff = diffWeeks(null, week(rows, [adoptionRow("seats", ["unadopted"], 30)]));

    expect(diff.gaps.map((c) => c.kind)).toEqual(["new", "new"]);
    expect(diff.adoption.map((c) => c.row.id)).toEqual(["seats"]);
  });

  it("marks rows grown, shrunk, same and gone against last week, keyed by head and pattern", () => {
    const previous = week([gap("gh pr view", "| jq -r", 40, 8), gap("gh run view", "| grep", 30, 5), gap("gh api", "| head", 9, 2), gap("sqlite3 events.db", "| tail", 7, 1)]);
    const current = week([gap("gh pr view", "| jq -r", 60, 11), gap("gh run view", "| grep", 10, 2), gap("gh api", "| head", 9, 2), gap("gh pr view", "| tail", 5, 1)]);

    const kinds = Object.fromEntries(diffWeeks(previous, current).gaps.map((c) => [`${c.row.head} ${c.row.pattern}`, c.kind]));

    expect(kinds).toEqual({ "gh pr view | jq -r": "grown", "gh run view | grep": "shrunk", "gh api | head": "same", "gh pr view | tail": "new", "sqlite3 events.db | tail": "gone" });
  });

  it("lists only adoption rows whose flags changed since last week", () => {
    const previous = week([], [adoptionRow("seats", [], 10), adoptionRow("ls", ["unused"], 20)]);
    const current = week([], [adoptionRow("seats", ["unadopted"], 17), adoptionRow("ls", ["unused"], 27)]);

    expect(diffWeeks(previous, current).adoption).toEqual([expect.objectContaining({ previousFlags: [], row: expect.objectContaining({ id: "seats" }) })]);
  });
});

describe("renderDigest", () => {
  const current = week([gap("gh pr view", "| jq -r", 60, 11)], [adoptionRow("seats", ["unadopted"], 17), adoptionRow("budget", ["unused"], 35)]);
  const diff = diffWeeks(null, current);
  const actions = planTaskActions(current.gaps.patterns, new Set(), []);

  it("lists new gaps, task actions, adoption results and removal candidates", () => {
    const digest = renderDigest(diff, actions, current.adoption);

    expect(digest).toContain("New gaps (1)\n- gh pr view | jq -r: 60 calls, 11 sessions");
    expect(digest).toContain(`filed: Tool gap: \`| jq -r\` after gh pr view [tool-gap:${patternId("| jq -r")}]`);
    expect(digest).toContain("Adoption results (2)\n- seats: agent-chat seats --brief, 4 new and 9 old uses, unadopted (was no flags)");
    expect(digest).toMatch(/Removal candidates, unused 28\+ days after ship \(1\)\n- budget:/);
  });

  it("leaves a shipped row unused for under four weeks off the removal list", () => {
    const young = week([], [adoptionRow("budget", ["unused"], 20)]);

    expect(renderDigest(diffWeeks(null, young), [], young.adoption)).toContain("Removal candidates, unused 28+ days after ship (0)\n- none");
  });

  it("is a notice that asks the owner nothing", () => {
    const digest = renderDigest(diff, actions, current.adoption);

    expect(digest).toContain("no reply needed");
    expect(digest).not.toContain("?");
  });
});
