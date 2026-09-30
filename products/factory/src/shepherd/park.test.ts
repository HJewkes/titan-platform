import { describe, expect, it } from "vitest";
import { parkImplementer, type ParkPort } from "./park.js";
import type { ShepherdStoreRef } from "./store.js";

const storeWith = (implementer?: string) => ({ get: () => ({ byRun: () => (implementer ? { implementer } : undefined) }) }) as unknown as ShepherdStoreRef;
const input = { runId: "run-1", headSha: "a".repeat(40) };

describe("parkImplementer", () => {
  it("skips without asking the broker when no registration names an implementer", () => {
    const asked: string[] = [];
    const park: ParkPort = (name) => (asked.push(name), { lines: [] });

    const outcome = parkImplementer(storeWith(), park, input);

    expect(outcome).toEqual({ kind: "skipped", reason: "no registration names the implementer" });
    expect(asked).toEqual([]);
  });

  it("answers a thrown non-Error as not parked rather than failing the step", () => {
    const park: ParkPort = () => {
      throw "socket closed";
    };

    expect(parkImplementer(storeWith("impl-a"), park, input)).toEqual({ kind: "not-parked", agent: "impl-a", reason: "socket closed", brokerDown: false });
  });
});
