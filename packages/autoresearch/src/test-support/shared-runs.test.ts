import { describe, expect, it } from "vitest";
import { sharedRuns } from "./shared-runs.js";

const named = (n: number) => () => n;

describe("sharedRuns", () => {
  it("gives two different functions with the same name separate runs", async () => {
    let calls = 0;
    const run = sharedRuns(async (plan: () => number) => (calls++, plan()), { hosts: [], repos: [] });
    const [first, second] = [named(1), named(2)];
    expect(first.name).toBe(second.name);

    expect([await run(first), await run(second), await run(first)]).toEqual([1, 2, 1]);
    expect(calls).toBe(2);
  });
});
