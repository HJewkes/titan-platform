import type { AgentRow } from "@titan-design/agent-dispatch";
import { describe, expect, it } from "vitest";
import { createRosterReader, mutating, ROSTER_TTL_MS } from "./roster.js";

const row = (name: string): AgentRow => ({
  name,
  agentId: `id-${name}`,
  state: "live",
  presence: "live",
  status: "running",
  profile: "implementer",
  surface: "headless",
  model: null,
  cwd: "/repo",
  sessionId: `session-${name}`,
  transcriptPath: null,
  transcriptExists: false,
  spawnedBy: null,
  account: null,
  generation: 1,
  teleportFrom: null,
});

/** A fake `agent ls`: each call is held until the test settles it, and the clock moves only when the test moves it. */
function scene() {
  let clock = 0;
  const pending: { resolve: (rows: AgentRow[]) => void; reject: (error: Error) => void }[] = [];
  const fetchRows = () => new Promise<readonly AgentRow[]>((resolve, reject) => void pending.push({ resolve, reject }));
  const reader = createRosterReader(fetchRows, { now: () => clock });
  return {
    reader,
    spawns: () => pending.length,
    settle: (rows: AgentRow[]) => pending.at(-1)!.resolve(rows),
    fail: (error: Error) => pending.at(-1)!.reject(error),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("the shared roster reader", () => {
  it("makes one agent ls for many concurrent runs, and one more only after the TTL window", async () => {
    const s = scene();

    const first = Array.from({ length: 11 }, () => s.reader.rows());
    s.settle([row("impl-a")]);
    const firstRows = await Promise.all(first);
    s.advance(ROSTER_TTL_MS - 1);
    const cached = await Promise.all(Array.from({ length: 11 }, () => s.reader.rows()));
    s.advance(1);
    const next = Array.from({ length: 11 }, () => s.reader.rows());
    s.settle([row("impl-b")]);
    const nextRows = await Promise.all(next);

    expect(s.spawns()).toBe(2);
    expect(firstRows.every((rows) => rows[0]?.name === "impl-a")).toBe(true);
    expect(cached.every((rows) => rows[0]?.name === "impl-a")).toBe(true);
    expect(nextRows.every((rows) => rows[0]?.name === "impl-b")).toBe(true);
  });

  it("reports a failed read as unknown to every caller sharing it, never as an empty roster", async () => {
    const s = scene();
    const broken = new Error("broker is down");

    const reads = [s.reader.read(), s.reader.read()];
    s.fail(broken);
    const results = await Promise.all(reads);

    expect(results).toEqual([{ kind: "unknown", error: broken }, { kind: "unknown", error: broken }]);
    expect(s.spawns()).toBe(1);
  });

  it("throws the read's own error from rows, so a port keeps telling a broker that is down from a refusal", async () => {
    const s = scene();
    const broken = new Error("broker is down");

    const rows = s.reader.rows();
    s.fail(broken);

    await expect(rows).rejects.toBe(broken);
  });

  it("does not cache a failure, so the next caller inside the TTL window reads again", async () => {
    const s = scene();

    const failed = s.reader.read();
    s.fail(new Error("timed out"));
    await failed;
    const retried = s.reader.rows();
    s.settle([row("impl-a")]);

    expect((await retried).map((found) => found.name)).toEqual(["impl-a"]);
    expect(s.spawns()).toBe(2);
  });

  it("reads fresh after a mutation inside the TTL window, even when the mutation fails", async () => {
    const s = scene();
    const before = s.reader.rows();
    s.settle([row("impl-a")]);
    await before;

    await mutating(s.reader, async () => Promise.reject(new Error("spawn timed out"))).catch(() => undefined);
    const after = s.reader.rows();
    s.settle([row("impl-a"), row("impl-a-s1")]);

    expect((await after).map((found) => found.name)).toEqual(["impl-a", "impl-a-s1"]);
    expect(s.spawns()).toBe(2);
  });

  it("does not let a read that started before a mutation answer the callers after it", async () => {
    const s = scene();

    void s.reader.rows();
    s.reader.invalidate();
    const fresh = s.reader.rows();
    s.settle([row("impl-a-s1")]);

    expect((await fresh).map((found) => found.name)).toEqual(["impl-a-s1"]);
    expect(s.spawns()).toBe(2);
  });
});
