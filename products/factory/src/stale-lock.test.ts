import { describe, expect, it } from "vitest";
import { describeIndexLock, inspectIndexLock, type LockProbe } from "./stale-lock.js";

const CHECKOUT = "/srv/checkout";
const LOCK = "/srv/checkout/.git/index.lock";
const NOW = Date.parse("2026-10-07T12:00:00Z");

function probe(ageMs: number | undefined, holder?: string): LockProbe & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    mtimeMs: (path) => (path === LOCK && ageMs !== undefined ? NOW - ageMs : undefined),
    holder: async (path) => {
      asked.push(path);
      return holder;
    },
    now: () => NOW,
  };
}

describe("the deploy checkout's index.lock", () => {
  it("is stale when no process holds it and it is older than 10 minutes, and names its path and age", async () => {
    const lock = await inspectIndexLock(CHECKOUT, probe(11 * 60_000));

    expect(lock).toEqual({ state: "stale", path: LOCK, ageMs: 11 * 60_000 });
    expect(describeIndexLock(lock)).toBe(`stale ${LOCK}, 11 min old with no process holding it; remove it to unblock the deploy`);
  });

  it("is fresh when nothing holds it but it is 10 minutes old or less", async () => {
    const lock = await inspectIndexLock(CHECKOUT, probe(10 * 60_000));

    expect(lock).toEqual({ state: "fresh", path: LOCK, ageMs: 10 * 60_000 });
  });

  it("is held, however old, while a process holds it", async () => {
    const lock = await inspectIndexLock(CHECKOUT, probe(9 * 60 * 60_000, "pid 77 (lsof)"));

    expect(lock).toEqual({ state: "held", path: LOCK, ageMs: 9 * 60 * 60_000, holder: "pid 77 (lsof)" });
    expect(describeIndexLock(lock)).toBe(`${LOCK} is held by pid 77 (lsof), 540 min old`);
  });

  it("is absent with no lock file, and the holder probe is never run", async () => {
    const fake = probe(undefined);

    const lock = await inspectIndexLock(CHECKOUT, fake);

    expect(lock).toEqual({ state: "absent", path: LOCK });
    expect(describeIndexLock(lock)).toBeUndefined();
    expect(fake.asked).toEqual([]);
  });
});
