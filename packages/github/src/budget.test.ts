import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import type { GhExec } from "./exec.js";
import { ghCliWire } from "./gh-cli.js";

const NOW = 1_000_000_000_000;

function clockedBudget(): { budget: ReturnType<typeof rateBudget>; slept: number[] } {
  const slept: number[] = [];
  const budget = rateBudget({ now: () => NOW, sleep: async (ms) => void slept.push(ms) });
  return { budget, slept };
}

const rate = (remaining: number, resource = "core") =>
  new Map([
    ["x-ratelimit-remaining", String(remaining)],
    ["x-ratelimit-reset", String(NOW / 1000 + 100)],
    ["x-ratelimit-resource", resource],
  ]);

describe("rate budget", () => {
  it("does not wait at or above 500 remaining", async () => {
    const { budget, slept } = clockedBudget();
    budget.observe(rate(501));

    await budget.acquire();

    expect(slept).toEqual([]);
  });

  it("spreads the calls left over the time to reset below 500 remaining", async () => {
    const { budget, slept } = clockedBudget();
    budget.observe(rate(499));

    await budget.acquire();
    await budget.acquire();

    expect(slept).toEqual([Math.ceil(100_000 / 499), Math.ceil(100_000 / 498)]);
    expect(budget.remaining).toBe(497);
  });

  it("waits out the whole window at zero remaining", async () => {
    const { budget, slept } = clockedBudget();
    budget.observe(rate(0));

    await budget.acquire();

    expect(slept).toEqual([100_000]);
  });

  it("ignores rate headers from another resource", async () => {
    const { budget, slept } = clockedBudget();
    budget.observe(rate(1, "search"));

    await budget.acquire();

    expect(slept).toEqual([]);
    expect(budget.remaining).toBeNull();
  });

  it("is shared: one wire's low remaining slows another wire's next call", async () => {
    const { budget, slept } = clockedBudget();
    const head = `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 10\r\nX-Ratelimit-Reset: ${NOW / 1000 + 100}\r\nX-Ratelimit-Resource: core\r\n\r\n`;
    const exec: GhExec = async () => ({ code: 0, stdout: `${head}{"default_branch":"main","status":"completed"}`, stderr: "" });

    await ghCliWire(exec, { budget }).getDefaultBranch("o/r");
    await ghCliWire(exec, { budget }).getWorkflowRunStatus("o/r", 1);

    expect(slept).toEqual([Math.ceil(100_000 / 10)]);
  });
});
