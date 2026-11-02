import { describe, expect, it } from "vitest";

import { parseAgentRows } from "./agents.js";

const row = (over: Record<string, unknown> = {}) => ({
  name: "item-42",
  agentId: "9e3faa6c",
  state: "exited",
  presence: "exited",
  status: "finished",
  profile: "headless-implementer",
  surface: "headless",
  cwd: "/work/tree",
  sessionId: "s-1",
  generation: 1,
  ...over,
});

const parsed = (over: Record<string, unknown>) => parseAgentRows(JSON.stringify([row(over)]))[0];

describe("a roster row's exit time", () => {
  it.each([
    ["an exited agent's ISO time", "2031-03-05T00:02:00.000Z"],
    ["null for an agent that has not exited", null],
  ])("passes through %s", (_scene, exitedAt) => {
    expect(parsed({ exitedAt })).toHaveProperty("exitedAt", exitedAt);
  });

  it("leaves exitedAt absent for a row that carries none, rather than claiming the agent never exited", () => {
    expect(parsed({})).not.toHaveProperty("exitedAt");
  });

  it("drops an exitedAt of the wrong type and keeps the row", () => {
    expect(parsed({ exitedAt: 1_700_000_000_000 })).toEqual(row());
  });
});
