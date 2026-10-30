import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/index.js";
import type { JournalRow } from "../host/index.js";
import { ROUTE_META_KEYS } from "../routing/index.js";
import { foldAgent } from "./fold.js";
import {
  assignmentMeta,
  assignmentRefusal,
  githubRepoOf,
  isWorkRole,
  spawnProvenance,
  successorProvenance,
  worktreeProvenance,
} from "./provenance.js";
import { inferWorkRole } from "./work-role.js";

/**
 * CC-915: the repo, branch and base commit an agent's worktree was cut from, the task it ran and
 * the role it played, recorded at spawn and at resume. The spawn row is the only place a later
 * exporter can read them from.
 */

const noGit = async () => null;
const originAt = (url: string) => async (args: string[]) =>
  args.includes("remote.origin.url") ? url : null;
const cut = {
  gitRoot: "/r",
  branch: "agent/worker-a",
  base: "abc123",
  base_ref: "origin/main",
};

const spawnRowWith = (meta: Record<string, string>): JournalRow => ({
  kind: "agent_spawned",
  ts: 1,
  actor: "human",
  target: "worker-a",
  msgId: "a1",
  ref: null,
  body: "do the task",
  meta: {
    name: "worker-a",
    profile: "explorer",
    cwd: "/w",
    session_id: "s",
    ...meta,
  },
});

describe("a worktree agent spawned with a task and role", () => {
  it("reads back its repo, branch, base commit, task and role from the folded record", async () => {
    const meta = await spawnProvenance(
      { cwd: "/w", ref: cut },
      { name: "worker-a", task: "T-1", workRole: "reviewer" },
      "explorer",
      originAt("https://github.com/acme/widget.git")
    );
    const host = memoryHost();
    host.journal.append(spawnRowWith(meta));

    const agent = foldAgent(host.journal.rowsFor("a1"));

    expect(agent).toMatchObject({
      repo: "acme/widget",
      branch: "agent/worker-a",
      base: { sha: "abc123", ref: "origin/main" },
      task: "T-1",
      workRole: "reviewer",
    });
    expect(agent?.workRoleInferred).toBeUndefined();
  });

  it("infers the role from the profile and name when none is stated, and marks it inferred", () => {
    expect(assignmentMeta({ name: "sx-x-1-s1-s1" }, "implementer")).toEqual({
      work_role: "fix-round-2",
      work_role_inferred: "true",
    });
  });

  it("refuses a role outside the vocabulary", () => {
    expect(assignmentRefusal({ workRole: "boss" })).toMatch(
      /role must be one of/
    );
  });

  it("refuses an experiment without an id or arm", () => {
    expect(assignmentRefusal({ experiment: { id: " ", arm: "a" } })).toMatch(
      /experiment needs/
    );
  });
});

describe("a burndown spawn", () => {
  it("is refused without a task id", () => {
    expect(assignmentRefusal({ spawnedAs: "burndown" })).toMatch(
      /burndown spawn needs a task id/
    );
    expect(assignmentRefusal({ spawnedAs: "burndown", task: "  " })).toMatch(
      /burndown spawn needs a task id/
    );
  });

  it("spawns with one", () => {
    expect(
      assignmentRefusal({ spawnedAs: "burndown", task: "T-1" })
    ).toBeUndefined();
  });
});

describe("route meta on the spawn row", () => {
  it("writes the route keys /routing defines and drops any other key", () => {
    const route = Object.fromEntries(
      ROUTE_META_KEYS.map((key) => [key, `v-${key}`])
    );

    const meta = assignmentMeta(
      { name: "n", workRole: "other", route: { ...route, route_bogus: "x" } },
      "explorer"
    );

    expect(
      Object.keys(meta)
        .filter((key) => key.startsWith("route_"))
        .sort()
    ).toEqual([...ROUTE_META_KEYS].sort());
  });

  it("carries a route override apart from the decision keys", () => {
    expect(
      assignmentMeta(
        { name: "n", workRole: "other", routeOverride: "keep profile" },
        "p"
      )
    ).toMatchObject({
      route_override: "keep profile",
    });
  });
});

describe("a teleport successor", () => {
  it("carries its predecessor's repo, branch, base, task and stated role", () => {
    const host = memoryHost();
    host.journal.append(
      spawnRowWith({
        repo: "acme/widget",
        branch: "b",
        base_sha: "abc",
        base_ref: "origin/main",
        task: "T-1",
        work_role: "reviewer",
      })
    );

    expect(successorProvenance(foldAgent(host.journal.rowsFor("a1")))).toEqual({
      repo: "acme/widget",
      branch: "b",
      base_sha: "abc",
      base_ref: "origin/main",
      task: "T-1",
      work_role: "reviewer",
    });
  });

  it("keeps an inferred role marked inferred", () => {
    const host = memoryHost();
    host.journal.append(spawnRowWith({}));

    expect(
      successorProvenance(foldAgent(host.journal.rowsFor("a1")))
    ).toMatchObject({
      work_role: "other",
      work_role_inferred: "true",
    });
  });

  it("carries nothing when there is no predecessor", () => {
    expect(successorProvenance(undefined)).toEqual({});
  });
});

describe("which allocations record a base", () => {
  it.each([
    ["a branch this spawn cut", {}, true],
    ["a fresh branch a resume cut", { reattached: "fresh" }, true],
    ["a reused branch", { reused: "true" }, false],
    ["a surviving local branch", { reattached: "local" }, false],
    ["a branch fetched from origin", { reattached: "origin" }, false],
    [
      "a re-created assigned worktree",
      { reattached: "fresh", assigned: "true" },
      false,
    ],
  ])("%s", async (_label, extra, recorded) => {
    const meta = await worktreeProvenance(
      { cwd: "/w", ref: { ...cut, ...extra } },
      noGit
    );

    expect("base_sha" in meta).toBe(recorded);
    expect(meta.branch).toBe("agent/worker-a");
  });

  it("records nothing for an allocation with no git root", async () => {
    expect(await worktreeProvenance({ cwd: "/w" }, noGit)).toEqual({});
  });
});

describe("an agent record written before these fields existed", () => {
  it("still loads, with an inferred role and no provenance fields", () => {
    const host = memoryHost();
    host.journal.append({
      ...spawnRowWith({ profile: "bd-reviewer", cwd: "/x" }),
      msgId: "a-old",
      target: "rv-acme-widget-12",
      meta: {
        name: "rv-acme-widget-12",
        profile: "bd-reviewer",
        cwd: "/x",
        session_id: "s",
      },
    });

    const agent = foldAgent(host.journal.rowsFor("a-old"));

    expect(agent).toMatchObject({
      name: "rv-acme-widget-12",
      workRole: "shepherd-review",
      workRoleInferred: true,
    });
    for (const field of ["base", "repo", "branch", "task"])
      expect(agent).not.toHaveProperty(field);
  });
});

describe("inferring a role", () => {
  it.each([
    ["sx-cc-1-review", "bd-reviewer", "reviewer"],
    ["rv-acme-widget-524-2", "bd-reviewer", "shepherd-review"],
    ["dc-td-789-apply-s1", "bd-implementer", "fix-round-1"],
    ["sx-tp-2088-cost-s1-s1-s1", "bd-implementer", "fix-round-3"],
    ["sx-cc-915-spawn-capture", "implementer-lite", "implementer"],
    ["sx-tp-2150-throughput-plan", "bd-planner", "planner"],
    ["scout", "explorer", "other"],
  ])("reads %s on %s as %s", (name, profile, role) => {
    expect(inferWorkRole(profile, name)).toBe(role);
  });

  it("accepts the vocabulary and a numbered fix round, and nothing else", () => {
    expect(
      [
        "implementer",
        "reviewer",
        "fix-round-3",
        "shepherd-review",
        "planner",
        "other",
      ].every(isWorkRole)
    ).toBe(true);
    expect(["fix-round-", "fix-round-x", "boss", ""].some(isWorkRole)).toBe(
      false
    );
  });
});

describe("reading owner/name from an origin URL", () => {
  it.each([
    ["https://github.com/acme/widget.git", "acme/widget"],
    ["git@github.com:acme/widget.git", "acme/widget"],
    ["https://github.com/acme/widget", "acme/widget"],
    ["/srv/git/widget.git", undefined],
  ])("%s", (url, slug) => {
    expect(githubRepoOf(url)).toBe(slug);
  });
});
