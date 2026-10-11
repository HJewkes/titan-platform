import { describe, expect, it } from "vitest";
import { agentChatSpans, activeWorkTaskDates } from "./flow-sources.js";
import type { Exec } from "./sources.js";

const roster = (rows: object[]): Exec => async () => ({ code: 0, stdout: JSON.stringify(rows), stderr: "" });

describe("flow sources", () => {
  it("reads roster rows as spans, live where a session holds the name", async () => {
    const rows = [
      { profile: "implementer", presence: "live", spawnedAt: "2026-03-10T10:00:00Z", name: "a" },
      { profile: "implementer", presence: "exited", spawnedAt: "2026-03-10T10:00:00Z", exitedAt: "2026-03-10T11:00:00Z" },
    ];

    const spans = await agentChatSpans(roster(rows), "agent-chat")();

    expect(spans.map((s) => s.live)).toEqual([true, false]);
    expect(spans[1]?.endedAt).toBe("2026-03-10T11:00:00Z");
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
