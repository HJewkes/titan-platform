import { ownerItemSchema, type SourceEvent } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { RUN_A, RUN_B, gateSnapshot } from "../test-support/owner-queue.js";
import { hitlGateSource } from "./hitl-source.js";

describe("hitlGateSource open", () => {
  it("lists pending gates only, each a schema-valid one-way approval", async () => {
    const items = await hitlGateSource({ gates: gateSnapshot() }).open();
    expect(items.map((item) => item.id)).toEqual([`gate:${RUN_A}/approve-merge`, `gate:${RUN_B}/ci-failed:2`, "gate:bare-gate"]);
    for (const item of items) {
      expect(() => ownerItemSchema.parse(item)).not.toThrow();
      expect(item).toMatchObject({ kind: "approve", door: "one-way", status: "open" });
    }
  });

  it("maps a briefed gate's summary, single question, rule and run", async () => {
    const [briefed] = await hitlGateSource({ gates: gateSnapshot() }).open();
    expect(briefed).toMatchObject({
      sources: [{ system: "hitl", ref: `${RUN_A}/approve-merge` }],
      summary: "Merge example/widgets#4: CI green, review clean. Recommend merge.",
      evidenceRef: "https://example.invalid/pull/4",
      options: [{ id: "merge", label: "Merge" }, { id: "hold", label: "Hold" }],
      recommended: { optionId: "merge", by: "titan-factory" },
      keys: [`gate:${RUN_A}/approve-merge`, `run:${RUN_A}`],
      unblocks: [`run:${RUN_A}`],
      authority: { table: "example-table", ruleId: "merge-approval", resolvers: ["owner-terminal"] },
      expiresAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("falls back to the prompt's first line for a gate with no brief", async () => {
    const items = await hitlGateSource({ gates: gateSnapshot() }).open();
    expect(items[1]!.summary).toBe("CI failed twice on example/widgets#5.");
  });

  it("keeps several questions in the context instead of flattening them into one menu", async () => {
    const bare = (await hitlGateSource({ gates: gateSnapshot() }).open())[2]!;
    expect(bare.options).toBeUndefined();
    expect(bare.context).toContain("second: Second? (c | d)");
    expect(bare.keys).toEqual(["gate:bare-gate"]);
  });
});

describe("hitlGateSource resolve and tail", () => {
  const answer = { optionId: "merge", by: { class: "owner-terminal", id: "owner", channel: "test" }, at: "2026-01-05T10:00:00Z" };

  it("refuses to answer a pending gate here and calls a settled one closed", async () => {
    const source = hitlGateSource({ gates: gateSnapshot() });
    expect(await source.resolve(`${RUN_A}/approve-merge`, answer)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await source.resolve(`${RUN_B}/sent-back`, answer)).toEqual({ ok: false, reason: "closed" });
  });

  it("reports a gate resolved elsewhere as answered", async () => {
    const gates = gateSnapshot();
    const controller = new AbortController();
    const events = hitlGateSource({ gates, pollMs: 1 }).tail(undefined, controller.signal)[Symbol.asyncIterator]();
    const next = events.next();
    gates.resolve("bare-gate", { first: "a", second: "c" }, { class: "owner-terminal", id: "owner", channel: "test" });
    const { value } = (await next) as { value: SourceEvent };
    controller.abort();
    expect(value).toEqual({ type: "closed", ref: "bare-gate", status: "answered", cursor: "1" });
  });
});
