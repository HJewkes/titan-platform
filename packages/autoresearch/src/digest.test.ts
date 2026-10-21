import { describe, expect, it } from "vitest";
import { buildDigest, implementerBrief, type EvidenceRow } from "./digest.js";
import { toIdea } from "./queue.js";
import { EMPTY_REGISTRIES, recordOutcome, REGISTRY_TAIL } from "./registry.js";
import { proposal } from "./test-support/fake-ports.js";

const row = (extra: Partial<EvidenceRow>): EvidenceRow => ({
  round: 1, ideaId: "i-1", cell: "accept-gate:x", rung: "L3", verdict: "neutral", reason: "not-better", deltaOverSigma: 0.5, usd: 0, source: "training", ...extra,
});

describe("planner digest", () => {
  it("never carries validator results, in the rows or in the cell table", () => {
    const evidence = [row({}), row({ ideaId: "i-head", cell: "milestone:head", verdict: "positive", source: "validator" })];

    const digest = buildDigest({ round: 2, evidence, registries: EMPTY_REGISTRIES, queue: [] });

    expect(digest.evidence.map((entry) => entry.ideaId)).toEqual(["i-1"]);
    expect(digest.cells.map((cell) => cell.cell)).toEqual(["accept-gate:x"]);
  });

  it("flags cells under three trials for exploration and weak cells for demotion", () => {
    const evidence = [row({ cell: "a:new" }), ...Array.from({ length: 3 }, () => row({ cell: "b:weak", deltaOverSigma: 0.2 }))];

    const cells = buildDigest({ round: 2, evidence, registries: EMPTY_REGISTRIES, queue: [] }).cells;

    expect(cells.map(({ cell, flag }) => [cell, flag])).toEqual([["a:new", "explore"], ["b:weak", "demote"]]);
  });

  it("caps each registry tail in the brief and puts the idea after the stable prefix", () => {
    const idea = toIdea(proposal("tail"), { round: 1, lineageOf: new Map() });
    const outcome = { ideaId: idea.id, lineage: idea.lineage, cell: idea.cell, verdict: "rejected" as const, reason: "rejected:post:no-test", rungReached: "L0" as const, runs: [] };
    const registries = Array.from({ length: REGISTRY_TAIL + 5 }, () => outcome).reduce((acc, entry) => recordOutcome(acc, idea, entry), EMPTY_REGISTRIES);

    const digest = buildDigest({ round: 2, evidence: [], registries, queue: [idea] });
    const brief = implementerBrief(digest, idea);

    expect(digest.registries.bugs).toHaveLength(REGISTRY_TAIL);
    expect(brief.split("\n---\n").at(-1)).toBe(JSON.stringify(idea));
  });
});
