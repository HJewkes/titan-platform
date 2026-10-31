import { describe, expect, it, vi } from "vitest";
import { qualifyTask } from "./task-ref.js";

function index(tasks: { id: string; slug: string }[]): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, data: { tasks } })));
}

const origin = "http://127.0.0.1:7400";

describe("qualifyTask", () => {
  it("resolves a bare ID that one initiative owns", async () => {
    const fetch = index([{ id: "CC-784", slug: "agent-chat" }, { id: "TP-1", slug: "titan-platform" }]);
    await expect(qualifyTask("CC-784", { origin, fetch })).resolves.toBe("agent-chat/CC-784");
  });

  it("refuses a bare ID no initiative has, naming the expected form", async () => {
    await expect(qualifyTask("CC-9999", { origin, fetch: index([{ id: "TP-1", slug: "titan-platform" }]) })).rejects.toThrow(
      "task CC-9999 is in no initiative; pass --task <initiative>/<ID>",
    );
  });

  it("refuses a bare ID that several initiatives share", async () => {
    const fetch = index([{ id: "X-1", slug: "a" }, { id: "X-1", slug: "b" }]);
    await expect(qualifyTask("X-1", { origin, fetch })).rejects.toThrow("is in 2 initiatives (a, b); pass --task <initiative>/<ID>");
  });

  it("refuses when the daemon cannot be reached", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("connection refused")));
    await expect(qualifyTask("CC-784", { origin, fetch })).rejects.toThrow("pass --task <initiative>/<ID>");
  });

  it("passes a qualified task through without a lookup", async () => {
    const fetch = index([]);
    await expect(qualifyTask("agent-chat/CC-784", { origin, fetch })).resolves.toBe("agent-chat/CC-784");
    expect(fetch).not.toHaveBeenCalled();
  });
});
