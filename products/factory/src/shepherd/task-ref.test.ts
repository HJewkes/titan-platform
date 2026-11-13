import { describe, expect, it, vi } from "vitest";
import { taskIndexFetch } from "../test-support/task-index.js";
import { loadTaskIndex, qualifyTask, TaskIndexUnavailable, TaskKeyRefused } from "./task-ref.js";

const origin = "http://127.0.0.1:7400";
const TASKS = [{ id: "CC-784", slug: "chan" }, { id: "TP-1", slug: "titan-platform" }];

describe("qualifyTask", () => {
  it("resolves a bare ID that one initiative owns", async () => {
    await expect(qualifyTask("CC-784", { origin, fetch: taskIndexFetch(TASKS) })).resolves.toBe("chan/CC-784");
  });

  it("keeps a key whose initiative holds the task", async () => {
    await expect(qualifyTask("titan-platform/TP-1", { origin, fetch: taskIndexFetch(TASKS) })).resolves.toBe("titan-platform/TP-1");
  });

  it("refuses a key with another initiative's prefix rather than correcting it", async () => {
    const refused = qualifyTask("titan-platform/CC-784", { origin, fetch: taskIndexFetch(TASKS) });
    await expect(refused).rejects.toBeInstanceOf(TaskKeyRefused);
    await expect(refused).rejects.toThrow("refused (wrong-initiative): task CC-784 is in chan, not titan-platform; pass --task <initiative>/<ID>");
  });

  it("refuses a bare ID no initiative has, naming the expected form", async () => {
    await expect(qualifyTask("CC-9999", { origin, fetch: taskIndexFetch(TASKS) })).rejects.toThrow("task CC-9999 is in no initiative; pass --task <initiative>/<ID>");
  });

  it("refuses a bare ID that several initiatives share and no prefix settles", async () => {
    const fetch = taskIndexFetch([{ id: "X-1", slug: "a" }, { id: "X-1", slug: "b" }], [{ slug: "a", task_prefix: "A" }, { slug: "b", task_prefix: "B" }]);
    await expect(qualifyTask("X-1", { origin, fetch })).rejects.toThrow("is in 2 initiatives (a, b); pass --task <initiative>/<ID>");
  });

  it("reports the index as unavailable when the daemon cannot be reached", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("connection refused")));
    await expect(qualifyTask("chan/CC-784", { origin, fetch })).rejects.toBeInstanceOf(TaskIndexUnavailable);
  });
});

describe("loadTaskIndex", () => {
  it("maps each initiative's task prefix and keeps only agent-visible initiatives as visible", async () => {
    const fetch = taskIndexFetch(TASKS, [{ slug: "chan", task_prefix: "CC" }, { slug: "titan-platform", task_prefix: "TP", agent_visible: false }]);

    const { index, agentVisible } = await loadTaskIndex({ origin, fetch });

    expect(index.prefixes).toEqual([{ initiative: "chan", taskPrefix: "CC" }, { initiative: "titan-platform", taskPrefix: "TP" }]);
    expect([...agentVisible]).toEqual(["chan"]);
  });
});
