import { describe, expect, it } from "vitest";
import { agentChatSpans, activeWorkTaskDates } from "./flow-sources.js";
import type { Exec } from "./sources.js";

const roster = (rows: object[]): Exec => async () => ({ code: 0, stdout: JSON.stringify(rows), stderr: "" });

/** A row in the full shape agent-chat's `lsJsonRow` prints, nulls included. */
const lsJsonRow = (name: string, spawnedBy: string | null, retired: boolean) => ({
  name,
  agentId: `id-${name}`,
  state: retired ? "retired" : "exited",
  presence: retired ? "detached" : "exited",
  status: retired ? "retired" : "exited",
  profile: "implementer",
  surface: "headless",
  model: null,
  cwd: "/repo",
  sessionId: "",
  transcriptPath: null,
  transcriptExists: false,
  spawnedBy,
  launchedBy: null,
  account: null,
  generation: 1,
  teleportFrom: null,
  ...(retired && { retired: true }),
  inferred: false,
  spawnedAt: "2026-03-10T10:00:00.000Z",
  contextK: null,
  retireK: null,
  retireDue: null,
});

/** Answers as the broker does: retired rows only when the call asks for them. */
const broker = (rows: ReturnType<typeof lsJsonRow>[]): Exec => async (_bin, args) => ({
  code: 0,
  stdout: JSON.stringify(args.includes("--include-retired") ? rows : rows.filter((row) => !row.retired)),
  stderr: "",
});

describe("flow sources", () => {
  it("reads roster rows as spans, live where a session holds the name, keeping a spawner that is not the human", async () => {
    const rows = [
      { profile: "implementer", presence: "live", spawnedAt: "2026-03-10T10:00:00Z", name: "a" },
      { profile: "implementer", presence: "exited", spawnedAt: "2026-03-10T10:00:00Z", exitedAt: "2026-03-10T11:00:00Z", name: "b", spawnedBy: "seat-a" },
      { profile: "implementer", presence: "exited", spawnedAt: "2026-03-10T10:00:00Z", name: "c", spawnedBy: null },
    ];

    const spans = await agentChatSpans(roster(rows), "agent-chat")();

    expect(spans.map((s) => s.live)).toEqual([true, false, false]);
    expect(spans[1]?.endedAt).toBe("2026-03-10T11:00:00Z");
    expect(spans.map((s) => s.spawnedBy)).toEqual([undefined, "seat-a", undefined]);
  });

  it("reads retired implementers and spawners too, so a spawned-by walk reaches the coordinator", async () => {
    const rows = [lsJsonRow("mid", "coord", true), lsJsonRow("impl", "mid", true), lsJsonRow("fresh", "coord", false)];

    const spans = await agentChatSpans(broker(rows), "agent-chat")();

    expect(spans.map((s) => [s.name, s.spawnedBy])).toEqual([
      ["mid", "coord"],
      ["impl", "mid"],
      ["fresh", "coord"],
    ]);
  });

  it("fails the read when the broker exits non-zero", async () => {
    const exec: Exec = async () => ({ code: 3, stdout: "", stderr: "no broker\n" });

    await expect(agentChatSpans(exec, "agent-chat")()).rejects.toThrow("exit 3: no broker");
  });

  it("fails the lookup when the daemon cannot be reached, rather than reporting the task absent", async () => {
    const down = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    await expect(activeWorkTaskDates({ origin: "http://127.0.0.1:1", fetch: down })("demo/T-1")).rejects.toThrow();
  });

  it("looks a task up in its initiative's list, reading each list once", async () => {
    let calls = 0;
    const fetchFake = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, data: { tasks: [{ id: "T-1", created: "2026-03-01" }, { id: "T-2", created: "2026-03-02" }] } }));
    }) as typeof fetch;
    const created = activeWorkTaskDates({ origin: "http://127.0.0.1:1", fetch: fetchFake });

    expect([await created("demo/T-1"), await created("demo/T-2"), await created("demo/T-3"), await created("T-1")]).toEqual(["2026-03-01", "2026-03-02", undefined, undefined]);
    expect(calls).toBe(1);
  });
});
