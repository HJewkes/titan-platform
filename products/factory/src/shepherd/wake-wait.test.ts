import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { ShepherdDeps } from "./phases.js";
import { SpawnDeferred } from "./spawn-gate.js";
import { deadlineFor, whileDeferred } from "./wake-wait.js";

const HOUR = 60 * 60_000;

function clocked() {
  const clock = { now: 0 };
  const deps = partialFake<ShepherdDeps>({ now: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), pollMs: 30_000 });
  return { clock, deps };
}

describe("a wake waiting out the spawn gate", () => {
  it("is admitted after the gate defers it for 2 hours", async () => {
    const { clock, deps } = clocked();
    const ask = async () => {
      if (clock.now < 2 * HOUR) throw new SpawnDeferred("busy");
    };

    await expect(whileDeferred(deps, deadlineFor({}, "deferred"), new AbortController().signal, ask)).resolves.toBeUndefined();
  });

  it("gives up once the gate has deferred it for 3 hours", async () => {
    const { clock, deps } = clocked();
    const ask = async () => Promise.reject(new SpawnDeferred("busy"));

    await expect(whileDeferred(deps, deadlineFor({}, "deferred"), new AbortController().signal, ask)).rejects.toBeInstanceOf(SpawnDeferred);
    expect(clock.now).toBe(3 * HOUR);
  });

  it("keeps 5 minutes for an ask that timed out", () => {
    expect(deadlineFor({}, "timeout")).toBe(5 * 60_000);
  });
});
