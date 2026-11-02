import type { ReviewerAgent } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { independentOfRun } from "./lineage.js";

const agent = (name: string, spawnedBy: string | null): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy, predecessor: null });

const rows = [agent("operator", null), agent("impl-a", "operator"), agent("rev-1", "operator")];
const lineage = { rows, complete: true };
const reviewer = agent("rev-1", "operator");

describe("independentOfRun", () => {
  it("clears a reviewer the lineage clears when no recorded author names it", () => {
    expect(independentOfRun(reviewer, { implementer: "impl-a" }, lineage, [{ agentId: "agent-impl-a", name: "impl-a" }])).toBe(true);
  });

  it("refuses an agent named among the run's authors, by id or by name", () => {
    const byId = [{ agentId: "agent-rev-1", name: "renamed" }];
    const byName = [{ agentId: "agent-other", name: "rev-1" }];

    expect(independentOfRun(reviewer, { implementer: "impl-a" }, lineage, byId)).toBe(false);
    expect(independentOfRun(reviewer, { implementer: "impl-a" }, lineage, byName)).toBe(false);
  });
});
