import { describe, expect, it } from "vitest";
import { bashEvent, withinParseBudget } from "./parse-budget.js";

const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });

/** Spins this thread for at least `ms` of CPU, so the run costs CPU rather than waiting. */
function spinCpu(ms: number): void {
  const start = process.threadCpuUsage();
  for (;;) {
    const { user, system } = process.threadCpuUsage(start);
    if ((user + system) / 1000 >= ms) return;
  }
}

const slowRun = async () => {
  spinCpu(30);
  return { stdout: DENY };
};

describe("withinParseBudget", () => {
  it("reports a run that spends more CPU than the budget, naming the time", async () => {
    const result = await withinParseBudget(slowRun, "ls", { ms: 10 });

    expect(result.cpuMs).toBeGreaterThanOrEqual(30);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/took \d+\.\d ms of CPU, budget 10 ms/);
  });

  it("reports nothing for the same run under a looser budget", async () => {
    const result = await withinParseBudget(slowRun, "ls", { ms: 1000 });

    expect(result.problems).toEqual([]);
  });

  it("reports a silent run as not denied when a deny is required", async () => {
    const result = await withinParseBudget(async () => ({ stdout: "" }), "ls", { mustDeny: true });

    expect(result.denied).toBe(false);
    expect(result.problems).toEqual(["not denied"]);
  });

  it("accepts a denying run when a deny is required", async () => {
    const result = await withinParseBudget(async () => ({ stdout: DENY }), "ls", { mustDeny: true });

    expect(result.denied).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("accepts a silent run when no deny is required", async () => {
    const result = await withinParseBudget(async () => ({ stdout: "" }), "ls", { mustDeny: false });

    expect(result.problems).toEqual([]);
  });

  it("hands the run a Bash event carrying the command", async () => {
    let seen = "";
    await withinParseBudget(async (input) => ((seen = input), { stdout: "" }), "git status");

    expect(JSON.parse(seen)).toMatchObject({ tool_name: "Bash", tool_input: { command: "git status" } });
  });
});

describe("bashEvent", () => {
  it("builds the PreToolUse shape the hook reads as Bash", () => {
    const event = JSON.parse(bashEvent("ls", "/x"));

    expect(event).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/x" });
  });
});
