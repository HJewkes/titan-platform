import { describe, expect, it } from "vitest";
import { NOW_MS, fixtureSnapshot } from "./fixture.js";
import { accountChip } from "./snapshot.js";

describe("accountChip", () => {
  it("names an account by its config dir's last segment, without the leading dot", () => {
    expect(accountChip("/home/you/.claude-profiles/acct-a")).toBe("acct-a");
    expect(accountChip("/home/you/.claude/")).toBe("claude");
    expect(accountChip(null)).toBe("default");
  });
});

describe("buildSnapshot", () => {
  it("lists live agents, then detached, then recently exited, newest spawn first", () => {
    const snapshot = fixtureSnapshot();

    expect(snapshot.agents.map((agent) => agent.name)).toEqual(["reviewer-b", "builder-a", "planner-c", "fixer-d"]);
  });

  it("drops an agent that exited longer ago than the roster keeps exits", () => {
    expect(fixtureSnapshot().agents.some((agent) => agent.name === "old-e")).toBe(false);
  });

  it("joins each agent's report, task, account and status-line readings", () => {
    const builder = fixtureSnapshot().agents.find((agent) => agent.name === "builder-a");

    expect(builder).toMatchObject({
      account: "acct-a",
      task: "DEMO-12",
      report: { word: "DONE", pr: "#41" },
      context: { source: "status-line", pct: 44, atMs: NOW_MS - 20_000 },
      cost: { usd: 4.1 },
    });
  });

  it("falls back to the transcript's token count when no status line was written", () => {
    const fixer = fixtureSnapshot().agents.find((agent) => agent.name === "fixer-d");

    expect(fixer?.context).toEqual({ source: "transcript", k: 120 });
    expect(fixer?.cost).toBeNull();
  });

  it("puts the accounts running agents first, with each reading's time, and leaves out an unused account with no reading", () => {
    const { accounts } = fixtureSnapshot();

    expect(accounts.map((strip) => [strip.account, strip.agents])).toEqual([
      ["acct-a", 1],
      ["acct-b", 1],
      ["claude", 1],
    ]);
    expect(accounts[0]?.readAtMs).toBe(NOW_MS - 40_000);
    expect(accounts[1]?.stale).toBe(true);
    expect(accounts[2]?.readAtMs).toBeNull();
  });
});
