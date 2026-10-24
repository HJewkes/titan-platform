import type { ReviewerAgent } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { provablyIndependent } from "./lineage.js";

const agent = (name: string, spawnedBy: string | null, generation = 0): ReviewerAgent => ({
  name,
  agentId: `agent-${name}-${generation}`,
  sessionId: `session-${name}-${generation}`,
  presence: generation === 0 ? "live" : "exited",
  spawnedBy,
  predecessor: null,
});

const teleportedCoord = (spawner: string | null = "coord"): ReviewerAgent[] => [agent("coord", spawner, 0), agent("coord", "coord", 1), agent("coord", "coord", 2), agent("coord", "coord", 3)];

describe("provablyIndependent", () => {
  it("clears a reviewer whose spawning seat teleported, so every generation of it names itself as spawner", () => {
    const reviewer = agent("rev-1", "coord");
    const roster = [...teleportedCoord(), agent("impl-a", "coord"), reviewer];

    expect(provablyIndependent(reviewer, "impl-a", roster)).toBe(true);
  });

  it("clears a teleported seat whose first generation another seat spawned", () => {
    const reviewer = agent("rev-1", "coord");
    const roster = [...teleportedCoord("operator"), agent("operator", null), agent("impl-a", "coord"), reviewer];

    expect(provablyIndependent(reviewer, "impl-a", roster)).toBe(true);
  });

  it("refuses a reviewer that is the implementer itself", () => {
    const seat = agent("impl-a", "coord");
    const roster = [...teleportedCoord(), seat];

    expect(provablyIndependent(seat, "impl-a", roster)).toBe(false);
  });

  it("refuses a reviewer whose teleported spawner was itself spawned by the implementer in one generation", () => {
    const reviewer = agent("rev-1", "coord");
    const roster = [...teleportedCoord(), agent("coord", "impl-a", 4), agent("impl-a", null), reviewer];

    expect(provablyIndependent(reviewer, "impl-a", roster)).toBe(false);
  });

  it("refuses a reviewer whose lineage loops through two other names", () => {
    const reviewer = agent("rev-1", "loop-a");
    const roster = [agent("loop-a", "loop-b"), agent("loop-b", "loop-a"), agent("impl-a", null), reviewer];

    expect(provablyIndependent(reviewer, "impl-a", roster)).toBe(false);
  });

  it("refuses a reviewer whose spawner has no stored lineage", () => {
    const reviewer = agent("rev-1", "coord");
    const { predecessor: _absent, ...unstored } = agent("coord", null);
    const roster = [unstored, agent("impl-a", "coord"), reviewer];

    expect(provablyIndependent(reviewer, "impl-a", roster)).toBe(false);
  });
});
