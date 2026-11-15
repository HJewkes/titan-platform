import { describe, expect, it, vi } from "vitest";
import { createRetrievalEngine } from "./engine.js";

const answering = (hitsFor: (query: string) => string[]) => ({
  name: "stub",
  retrieve: vi.fn(async (query: string) => hitsFor(query).map((id, i) => ({ id, rank: i + 1 }))),
});
const onlyFor = (query: string, ids: string[]) => answering((q) => (q === query ? ids : []));

describe("recovery steps", () => {
  it("never calls a step when the query has hits", async () => {
    const step = { name: "fix", run: vi.fn(() => "other") };
    const engine = createRetrievalEngine({ retrievers: [onlyFor("q", ["a"])], recovery: [step] });

    const response = await engine.search("q");

    expect(step.run).not.toHaveBeenCalled();
    expect(response.recovered).toBeUndefined();
  });

  it("never calls a step when every retriever failed", async () => {
    const broken = { name: "broken", retrieve: async () => Promise.reject(new Error("down")) };
    const step = { name: "fix", run: vi.fn(() => "other") };
    const engine = createRetrievalEngine({ retrievers: [broken], recovery: [step] });

    const response = await engine.search("q");

    expect(step.run).not.toHaveBeenCalled();
    expect(response.results).toEqual([]);
  });

  it("skips the steps when the call passes recover: false", async () => {
    const step = { name: "fix", run: vi.fn(() => "q2") };
    const engine = createRetrievalEngine({ retrievers: [onlyFor("q2", ["a"])], recovery: [step] });

    const response = await engine.search("q", { recover: false });

    expect(step.run).not.toHaveBeenCalled();
    expect(response.results).toEqual([]);
  });

  it("passes a null step to the next and reports which step recovered", async () => {
    const first = { name: "none", run: vi.fn(() => null) };
    const second = { name: "stem", run: vi.fn(async () => "q2") };
    const third = { name: "late", run: vi.fn(() => "q3") };
    const engine = createRetrievalEngine({ retrievers: [onlyFor("q2", ["a"])], recovery: [first, second, third] });

    const response = await engine.search("q");

    expect(first.run).toHaveBeenCalledWith("q", expect.anything());
    expect(response.results.map((r) => r.id)).toEqual(["a"]);
    expect(response.recovered).toEqual({ step: "stem", query: "q2" });
    expect(third.run).not.toHaveBeenCalled();
  });

  it("moves past a step whose rewrite finds nothing", async () => {
    const engine = createRetrievalEngine({
      retrievers: [onlyFor("q3", ["a"])],
      recovery: [{ name: "miss", run: () => "q2" }, { name: "hit", run: () => "q3" }],
    });

    const response = await engine.search("q");

    expect(response.recovered).toEqual({ step: "hit", query: "q3" });
  });

  it("degrades a throwing step as recovery:<name> and moves on", async () => {
    const engine = createRetrievalEngine({
      retrievers: [onlyFor("q2", ["a"])],
      recovery: [{ name: "boom", run: () => { throw new Error("bad"); } }, { name: "ok", run: () => "q2" }],
    });

    const response = await engine.search("q");

    expect(response.degraded).toEqual([{ retriever: "recovery:boom", reason: "error", message: "bad" }]);
    expect(response.recovered?.step).toBe("ok");
  });

  it("degrades a step that outlives recoveryTimeoutMs and moves on", async () => {
    const slow = { name: "slow", run: (_q: string, { signal }: { signal: AbortSignal }) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) };
    const engine = createRetrievalEngine({
      retrievers: [onlyFor("q2", ["a"])],
      recovery: [slow, { name: "ok", run: () => "q2" }],
      recoveryTimeoutMs: 10,
    });

    const response = await engine.search("q");

    expect(response.degraded.map((d) => [d.retriever, d.reason])).toEqual([["recovery:slow", "timeout"]]);
    expect(response.recovered?.step).toBe("ok");
  });

  it("reports step timings next to the retrievers'", async () => {
    const engine = createRetrievalEngine({ retrievers: [onlyFor("q2", ["a"])], recovery: [{ name: "stem", run: () => "q2" }] });

    const { timingsMs } = await engine.search("q");

    expect(Object.keys(timingsMs).sort()).toEqual(["recovery:stem", "stub"]);
  });

  it("lets trigger replace the empty test", async () => {
    const step = { name: "fix", run: vi.fn(() => "q2") };
    const engine = createRetrievalEngine({
      retrievers: [answering((q) => (q === "q" ? ["a"] : ["b"]))],
      recovery: [step],
      recoveryTrigger: (lists) => lists.every((l) => l.hits.length < 2),
    });

    const response = await engine.search("q");

    expect(response.results.map((r) => r.id)).toEqual(["b"]);
    expect(response.recovered).toEqual({ step: "fix", query: "q2" });
  });
});
