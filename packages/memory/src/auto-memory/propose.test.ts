import { describe, expect, it } from "vitest";
import { dedupeFacts } from "./dedupe.js";
import { fact } from "./facts.fixture.js";
import { groupFacts } from "./group.js";
import { proposeDestination } from "./propose.js";
import type { FactGroup, ParsedFact } from "./types.js";

const NOW = new Date("2026-10-10T00:00:00Z");

function onlyGroup(...facts: ParsedFact[]): FactGroup {
  const groups = groupFacts(dedupeFacts(facts));
  const [group] = groups;
  if (!group || groups.length !== 1) throw new Error(`fixture should form one group, formed ${groups.length}`);
  return group;
}

const CI = onlyGroup(
  fact("ci-release-changeset", { description: "CI release needs a changeset" }),
  fact("ci-release-order", { description: "CI release order matters" }),
);
const COORDINATION = onlyGroup(
  fact("coordinator-questions", { description: "Coordinator asks no blocking questions" }),
  fact("coordinator-merges", { description: "Coordinator merges blocking work" }),
);

describe("proposeDestination", () => {
  it("sends a group whose topic matches an existing skill to that skill", () => {
    const skills = [{ name: "release", description: "CI release changeset order" }];
    expect(proposeDestination(CI, skills, { now: NOW })).toMatchObject({ destination: "skill:release", reason: expect.stringContaining("release") });
  });

  it("sends coordination feedback to the charter", () => {
    expect(proposeDestination(COORDINATION, [], { now: NOW })).toMatchObject({ destination: "charter", reason: expect.stringContaining("coordination") });
  });

  it("prefers a matching skill over the charter, because rule order is the policy", () => {
    const skills = [{ name: "coordination", description: "coordinator blocking questions" }];
    expect(proposeDestination(COORDINATION, skills, { now: NOW }).destination).toBe("skill:coordination");
  });

  it("sends guidance repeated across projects to the global CLAUDE.md", () => {
    const group = onlyGroup(
      fact("owner-timezone", { description: "Owner lives in Pacific time", project: "p1" }),
      fact("owner-timezone", { description: "Owner lives in Pacific time", project: "p2", type: "user" }),
    );
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "claude-md:global", reason: expect.stringContaining("2 projects") });
  });

  it("proposes deleting project facts untouched for longer than the stale window", () => {
    const group = onlyGroup(fact("sprint-goal", { description: "Sprint goal is the importer", type: "project", modified: "2026-01-01" }));
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "delete", reason: expect.stringContaining("30 days") });
  });

  it("keeps a recently modified project fact", () => {
    const group = onlyGroup(fact("sprint-goal", { description: "Sprint goal is the importer", type: "project", modified: "2026-10-01" }));
    expect(proposeDestination(group, [], { now: NOW }).destination).toBe("new-skill:goal-importer-sprint");
  });

  it("sends guidance from one project to that project's CLAUDE.md", () => {
    const group = onlyGroup(fact("owner-timezone", { description: "Owner lives in Pacific time", project: "p1" }));
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "claude-md:p1", reason: expect.stringContaining("p1") });
  });

  it("proposes a new skill named from the group label when nothing else fits", () => {
    const group = onlyGroup(fact("api-docs", { description: "API docs live on the wiki", type: "reference" }));
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "new-skill:api-docs-live", reason: expect.any(String) });
  });
});
