import { describe, expect, it } from "vitest";
import { gatherFailOpen } from "./fail-open.js";
import type { Retriever } from "./types.js";

const good: Retriever = { name: "good", retrieve: async () => [{ id: "a", rank: 1 }] };
const broken: Retriever = {
  name: "broken",
  retrieve: async () => {
    throw new Error("index locked");
  },
};
const slow: Retriever = {
  name: "slow",
  retrieve: (_q, { signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve([{ id: "late", rank: 1 }]), 200);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    }),
};

describe("gatherFailOpen", () => {
  it("keeps the healthy retriever's results when another throws", async () => {
    const { lists, degraded } = await gatherFailOpen([good, broken], "q", { limit: 5 });
    expect(lists).toEqual([{ name: "good", hits: [{ id: "a", rank: 1 }] }]);
    expect(degraded).toEqual([{ retriever: "broken", reason: "error", message: "index locked" }]);
  });

  it("times out a stalled retriever without blocking the others", async () => {
    const started = Date.now();
    const { lists, degraded, timingsMs } = await gatherFailOpen([good, slow], "q", { limit: 5, timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(150);
    expect(lists.map((l) => l.name)).toEqual(["good"]);
    expect(degraded[0]).toMatchObject({ retriever: "slow", reason: "timeout" });
    expect(timingsMs.slow).toBeGreaterThanOrEqual(25);
  });

  it("reports an external abort as an error, not a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const { degraded } = await gatherFailOpen([slow], "q", { limit: 5, signal: controller.signal });
    expect(degraded[0]).toMatchObject({ retriever: "slow", reason: "error" });
  });

  it("degrades every retriever as an error when the signal is already aborted", async () => {
    const finished: string[] = [];
    const recording = (name: string): Retriever => ({
      name,
      retrieve: async (_q, { signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal?.aborted) throw new Error("aborted");
        finished.push(name);
        return [{ id: name, rank: 1 }];
      },
    });
    const { lists, degraded } = await gatherFailOpen([recording("a"), recording("b")], "q", { limit: 5, signal: AbortSignal.abort() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lists).toEqual([]);
    expect(degraded.map((d) => [d.retriever, d.reason])).toEqual([["a", "error"], ["b", "error"]]);
    expect(finished).toEqual([]);
  });
});
