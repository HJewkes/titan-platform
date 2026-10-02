import { describe, expect, it } from "vitest";
import { emptyModel, fakeSources, NOW, SLOT, watchRow } from "../test-support/digest.js";
import { collectDigest } from "./collect.js";
import { queueAsk } from "./queues.js";
import { rankDigest } from "./rank.js";

const RUN = "22222222-2222-4222-8222-222222222222";

describe("rankDigest", () => {
  it("lists a PR once when a factory gate and a seat queue item both ask about it", async () => {
    const sources = fakeSources({
      rows: async () => [watchRow({ pr: 42, runId: RUN, phase: "awaiting-approval" })],
      gates: async () => [{ runId: RUN, stepId: "approve-merge", prompt: "Merge PR #42?", resolve: `titan-factory gate resolve ${RUN} approve-merge --json '<payload>'` }],
      queueAsks: () => [queueAsk("seat-a", "**widgets#42:** recommend merge, CI green"), queueAsk("seat-a", "Unrelated ask")],
    });
    const model = await collectDigest({ sources, now: NOW, windowMinutes: 360, slot: SLOT });

    const ranked = rankDigest(model);

    expect(ranked.needsYou.map((ask) => ask.source)).toEqual(["factory", "seat-a"]);
    expect(ranked.needsYou[1]!.text).toBe("Unrelated ask");
  });

  it("matches a queue item to a gate by the run id it quotes", () => {
    const gate = { text: "gate", source: "factory", keys: [`run:${RUN}`] };
    const queued = queueAsk("seat-a", `resolve it: \`titan-factory gate resolve ${RUN} approve-merge\``);

    expect(rankDigest(emptyModel({ needsYou: [gate, queued] })).needsYou).toEqual([gate]);
  });

  it("puts the newest merge and the oldest stuck item first and counts what the caps hid", () => {
    const merged = Array.from({ length: 7 }, (_, i) => ({ ref: `acme/widgets#${i + 1}`, title: "t", at: `2026-03-10T1${i}:00:00Z` }));
    const stuck = [
      { ref: "a", reason: "r", since: "2026-03-10T12:00:00Z" },
      { ref: "b", reason: "r", since: "2026-03-09T12:00:00Z" },
    ];

    const ranked = rankDigest(emptyModel({ merged, stuck }));

    expect(ranked.merged.map((m) => m.ref)).toEqual(["acme/widgets#7", "acme/widgets#6", "acme/widgets#5", "acme/widgets#4", "acme/widgets#3"]);
    expect(ranked.stuck.map((s) => s.ref)).toEqual(["b", "a"]);
    expect(ranked.totals).toEqual({ needsYou: 0, merged: 7, stuck: 2 });
    expect(ranked.overflow).toBe(2);
  });

  it("counts a merge that Shepherd and the GitHub search both report once", () => {
    const merged = [{ ref: "acme/widgets#5", title: "a", at: "2026-03-10T12:00:00Z" }, { ref: "acme/widgets#5", title: "b" }];

    expect(rankDigest(emptyModel({ merged })).totals.merged).toBe(1);
  });
});
