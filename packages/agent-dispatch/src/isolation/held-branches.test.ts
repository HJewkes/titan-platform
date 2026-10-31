import { describe, expect, it } from "vitest";
import { heldBranches, reviewedAgentName } from "./index.js";
import { agent, allocated, ROOT } from "./retire-test-support.js";
import { allocatedWorktree } from "./index.js";

/** CC-1325: which branches' open PRs keep an implementer or reviewer from the bulk finished retire. */

const held = (
  name: string,
  roster = [agent(name)],
  events = [allocated(name, `agent-chat/${name}`)]
) => {
  const self = roster.find((a) => a.name === name) ?? agent(name);
  return heldBranches(
    self,
    allocatedWorktree(events, self.agentId),
    roster,
    events
  );
};

describe("reviewedAgentName", () => {
  it.each([
    ["tc-x-2-a-review", "tc-x-2-a"],
    ["tc-x-3-b-review-r2", "tc-x-3-b"],
    ["tc-x-1-a-r1", "tc-x-1-a"],
  ])("reads %s as a reviewer of %s", (name, base) => {
    expect(reviewedAgentName(name)).toBe(base);
  });

  it("does not read a name that only contains review as a reviewer", () => {
    expect(reviewedAgentName("tc-x-1-reviewer")).toBeUndefined();
    expect(reviewedAgentName("tc-x-1-a")).toBeUndefined();
  });
});

describe("heldBranches", () => {
  it("holds an implementer on its own branch", () => {
    expect(held("tc-x-1-a")).toEqual([
      { gitRoot: ROOT, branch: "agent-chat/tc-x-1-a" },
    ]);
  });

  it("holds an attempt-suffixed agent on both its name's branch and its allocated branch", () => {
    const events = [allocated("tc-x-5-a3", "agent-chat/tc-x-5-a")];

    expect(
      held("tc-x-5-a3", [agent("tc-x-5-a3")], events).map((c) => c.branch)
    ).toEqual(["agent-chat/tc-x-5-a3", "agent-chat/tc-x-5-a"]);
  });

  it.each(["tc-x-1-a-review", "tc-x-1-a-review-r2", "tc-x-1-a-r1"])(
    "holds reviewer %s on the base agent's branch",
    (name) => {
      const roster = [agent("tc-x-1-a"), agent(name)];
      const events = [
        allocated("tc-x-1-a", "agent-chat/tc-x-1-a"),
        allocated(name, `agent-chat/${name}`),
      ];

      expect(held(name, roster, events).map((c) => c.branch)).toContain(
        "agent-chat/tc-x-1-a"
      );
    }
  );

  it("reads a non-default base branch from the base agent's allocation", () => {
    const roster = [agent("tc-x-4-lint"), agent("tc-x-4-lint-review")];
    const events = [
      allocated("tc-x-4-lint", "fix/x-4-lint-wrap"),
      allocated("tc-x-4-lint-review", "agent-chat/tc-x-4-lint-review"),
    ];

    expect(
      held("tc-x-4-lint-review", roster, events).map((c) => c.branch)
    ).toContain("fix/x-4-lint-wrap");
  });

  it("lists a branch once however many routes name it", () => {
    const roster = [agent("tc-x-1-a"), agent("tc-x-1-a-review")];
    const events = [
      allocated("tc-x-1-a", "agent-chat/tc-x-1-a"),
      allocated("tc-x-1-a-review", "agent-chat/tc-x-1-a-review"),
    ];

    const branches = held("tc-x-1-a-review", roster, events).map(
      (c) => c.branch
    );

    expect(branches.filter((b) => b === "agent-chat/tc-x-1-a")).toHaveLength(1);
  });

  it("names nothing for an agent that has no repo to ask", () => {
    expect(held("tc-x-1-reviewer", [agent("tc-x-1-reviewer")], [])).toEqual([]);
  });
});
