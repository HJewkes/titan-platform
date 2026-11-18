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
    const group = onlyGroup(fact("api-docs", { description: "API docs live on the wiki", type: "project", modified: "2026-10-01" }));
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "new-skill:api-docs-live", reason: expect.any(String) });
  });

  it("sends a group of only reference facts to the project's reference data", () => {
    const group = onlyGroup(fact("api-docs", { description: "API docs live on the wiki", type: "reference", project: "p1" }));
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "reference:p1", reason: expect.stringContaining("reference") });
  });

  it("sends feedback about a permission setting to config rather than a CLAUDE.md", () => {
    const group = onlyGroup(
      fact("shell-prompts", { description: "Never prompt; set the permission mode in settings", project: "p1" }),
      fact("shell-prompts", { description: "Never prompt; set the permission mode in settings", project: "p2" }),
    );
    expect(proposeDestination(group, [], { now: NOW })).toMatchObject({ destination: "config", reason: expect.stringContaining("config") });
  });

  it("sends a group naming an environment variable or hook to config", () => {
    const env = onlyGroup(fact("token-var", { description: "Export the API_TOKEN environment variable", project: "p1" }));
    const hook = onlyGroup(fact("pre-commit", { description: "A pre-commit hook runs the linter", project: "p1" }));
    expect([proposeDestination(env, [], { now: NOW }).destination, proposeDestination(hook, [], { now: NOW }).destination]).toEqual(["config", "config"]);
  });

  it("keeps the old destination for a mixed reference and feedback group", () => {
    const group = onlyGroup(
      fact("api-docs", { description: "API docs live on the wiki", type: "reference", project: "p1" }),
      fact("api-docs-style", { description: "API docs live on the wiki, keep them short", type: "feedback", project: "p1" }),
    );
    expect(proposeDestination(group, [], { now: NOW }).destination).toBe("new-skill:api-docs-live");
  });

  it("still deletes a stale project fact that mentions a setting", () => {
    const group = onlyGroup(fact("settings-page", { description: "Sprint goal: ship the settings page", type: "project", modified: "2026-01-01" }));
    expect(proposeDestination(group, [], { now: NOW }).destination).toBe("delete");
  });

  it("sends a reference group spanning two projects to the first project's reference data", () => {
    const group = onlyGroup(
      fact("api-docs", { description: "API docs live on the wiki", type: "reference", project: "p2" }),
      fact("api-docs", { description: "API docs live on the wiki", type: "reference", project: "p1" }),
    );
    expect(proposeDestination(group, [], { now: NOW }).destination).toBe("reference:p1");
  });

  it("prefers a matching skill over config and reference destinations", () => {
    const skills = [{ name: "permissions", description: "permission settings mode" }];
    const group = onlyGroup(fact("perm-mode", { description: "Permission settings mode", project: "p1" }));
    expect(proposeDestination(group, skills, { now: NOW }).destination).toBe("skill:permissions");
  });
});
