import { describe, expect, it } from "vitest";
import { countCalls } from "./count-calls.js";

const pushes = (count: number) => {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(i);
};

describe("countCalls", () => {
  it("counts the calls a run makes to each method and puts the methods back", () => {
    const push = Array.prototype.push;

    const calls = countCalls([[Array.prototype, "push"], [Map.prototype, "get"]], () => {
      pushes(3);
      new Map([[1, 2]]).get(1);
    });

    expect(calls).toBe(4);
    expect(Array.prototype.push).toBe(push);
  });

  it("stops a run at the first call past the cap and reports a count above it", () => {
    let reached = 0;

    const calls = countCalls([[Array.prototype, "push"]], () => {
      for (let i = 0; i < 1_000_000; i += 1) {
        [].push(i as never);
        reached = i;
      }
    }, 10);

    expect(calls).toBe(11);
    expect(reached).toBe(9);
  });

  it("keeps throwing past the cap when the code under test catches the first throw", () => {
    const calls = countCalls([[Array.prototype, "push"]], () => {
      for (let i = 0; i < 100; i += 1) {
        try {
          [].push(i as never);
        } catch {
          // The code under test swallows the error, as a fail-open wrapper would.
        }
      }
    }, 10);

    expect(calls).toBe(100);
  });

  it("rethrows an error of the run itself after putting the methods back", () => {
    const push = Array.prototype.push;

    expect(() => countCalls([[Array.prototype, "push"]], () => {
      throw new Error("from the run");
    })).toThrow("from the run");
    expect(Array.prototype.push).toBe(push);
  });
});
