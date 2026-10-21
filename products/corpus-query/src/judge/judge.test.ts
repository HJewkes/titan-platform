import { describe, expect, it } from "vitest";
import { assertsMatch, buildBatches, buildJudgePrefix, CONFIRM_ROLE, prefixSha, resolveLabels, SCREEN_ROLE, verifyVerdict, type ShownPassage } from "./index.js";
import type { QuerySpec } from "../types.js";

const spec: QuerySpec = {
  entity: "trophy won by the Harbour Rovers",
  rowFields: ["entity", "subject", "period", "detail"],
  termGroups: [["trophy", "cup*"]],
  phrases: [],
  seedLexicon: [],
  mode: "broad",
  inclusion: ["the club lifts the silverware on the page"],
  exclusion: ["hypothetical talk"],
  canaries: [
    { text: "Harbour Rovers lifted the Coastal Cup after a tense final against Dunmore Athletic.", expect: "match" },
    { text: "Nobody at Harbour Rovers mentioned any silverware before the long coach ride home.", expect: "no-match" },
  ],
};

const passages: ShownPassage[] = [
  { id: "PM/1/1#p0-1", ref: "PM 1.1", text: "The Rovers beat Kestrel Town in the Coastal Cup final, and the captain raised the trophy at dusk." },
  { id: "PM/1/2#p3-4", ref: "PM 1.2", text: "Training moved indoors because the pitch was flooded again, so the squad spent the morning on drills." },
];

const prefixFor = (rules?: string) => buildJudgePrefix({ role: SCREEN_ROLE, question: "List every cup won", spec, rules });
const batchFor = (canaryIndex = 0) => {
  const [batch] = buildBatches(passages, {
    tokenBudget: 10_000,
    prefixSha: prefixSha(prefixFor()),
    canaries: [spec.canaries[canaryIndex]!],
  });
  return batch!;
};
const fullVerdict = <T extends { id: string; quote: string }>(batch: ReturnType<typeof batchFor>, items: T[]) => ({
  judged: [...batch.passages.map((p) => p.id), batch.canary!.id],
  items,
});

describe("judge prefix", () => {
  it("is byte-identical for an identical spec", () => {
    expect(prefixFor("Ruling 1: youth sides do not count.")).toBe(prefixFor("Ruling 1: youth sides do not count."));
  });

  it("carries the rules verbatim, including odd whitespace", () => {
    const rules = "  Ruling 1:\n\tWomen's titles count only in DoF.  \n";
    expect(prefixFor(rules)).toContain(rules);
  });

  it("keeps canaries out, so batches can differ without changing the prefix", () => {
    const other = { ...spec, canaries: [] };
    expect(buildJudgePrefix({ role: SCREEN_ROLE, question: "q", spec })).toBe(
      buildJudgePrefix({ role: SCREEN_ROLE, question: "q", spec: other }),
    );
  });
});

describe("batching", () => {
  it("puts the canary after every real passage", () => {
    const batch = batchFor();
    const lastLabel = [...batch.message.matchAll(/^=== PASSAGE (\S+) /gm)].at(-1)![1]!;
    expect(batch.labels[lastLabel]).toBe(batch.canary!.id);
  });

  it("shows short labels instead of passage ids and resolves a verdict's labels back to ids", () => {
    const batch = batchFor();

    const resolved = resolveLabels(batch, { judged: ["P1", "P2", "P3"], items: [{ id: "P1", quote: "q" }] });

    expect(passages.some((p) => batch.message.includes(p.id))).toBe(false);
    expect(resolved).toEqual({ judged: [passages[0]!.id, passages[1]!.id, batch.canary!.id], items: [{ id: passages[0]!.id, quote: "q" }] });
  });

  it("keeps a name that is not a label, so verification voids it as an unknown id", () => {
    const batch = batchFor();

    const resolved = resolveLabels(batch, { judged: [], items: [{ id: "P9", quote: "q" }, { id: "constructor", quote: "q" }] });

    expect(verifyVerdict(batch, resolved).voided).toEqual([{ id: "P9", reason: "unknown-id" }, { id: "constructor", reason: "unknown-id" }]);
  });

  it("splits on the token budget without splitting a passage and keeps order", () => {
    const batches = buildBatches(passages, { tokenBudget: 40, prefixSha: "x", canaries: spec.canaries });
    expect(batches.map((b) => b.passages.map((p) => p.id))).toEqual([[passages[0]!.id], [passages[1]!.id]]);
  });

  it("derives the batch key from the passages and the prefix, not their order", () => {
    const a = buildBatches(passages, { tokenBudget: 10_000, prefixSha: "x", canaries: [] })[0]!;
    const b = buildBatches([...passages].reverse(), { tokenBudget: 10_000, prefixSha: "x", canaries: [] })[0]!;
    const c = buildBatches(passages, { tokenBudget: 10_000, prefixSha: "y", canaries: [] })[0]!;
    expect([a.key === b.key, a.key === c.key]).toEqual([true, false]);
  });
});

describe("verifyVerdict", () => {
  const goodQuote = "the captain raised the trophy at dusk";

  it("keeps a quote that appears in its own passage", () => {
    const batch = batchFor();
    const result = verifyVerdict(batch, fullVerdict(batch, [
      { id: passages[0]!.id, quote: goodQuote },
      { id: batch.canary!.id, quote: "lifted the Coastal Cup after a tense final" },
    ]));
    expect(result.items.map((i) => i.id)).toEqual([passages[0]!.id]);
  });

  it("voids a fabricated quote", () => {
    const batch = batchFor();
    const result = verifyVerdict(batch, fullVerdict(batch, [{ id: passages[0]!.id, quote: "the mayor handed over the shield" }]));
    expect(result.voided).toEqual([{ id: passages[0]!.id, reason: "quote-not-in-passage" }]);
  });

  it("voids a quote from passage A cited for passage B", () => {
    const batch = batchFor();
    const result = verifyVerdict(batch, fullVerdict(batch, [{ id: passages[1]!.id, quote: goodQuote }]));
    expect(result.voided).toEqual([{ id: passages[1]!.id, reason: "quote-not-in-passage" }]);
  });

  it("voids a 26-word quote even when it is verbatim, and accepts 25", () => {
    const words = Array.from({ length: 26 }, (_, i) => `word${i}`);
    const long = [{ id: "L", ref: "PM 9.9", text: words.join(" ") }];
    const batch = buildBatches(long, { tokenBudget: 10_000, prefixSha: "x", canaries: [] })[0]!;
    const verdict = (n: number) => verifyVerdict(batch, { judged: ["L"], items: [{ id: "L", quote: words.slice(0, n).join(" ") }] });
    expect([verdict(26).voided[0]?.reason, verdict(25).items.length]).toEqual(["quote-too-long", 1]);
  });

  it("voids an id that was not in the batch", () => {
    const batch = batchFor();
    const result = verifyVerdict(batch, fullVerdict(batch, [{ id: "PM/9/9#p0-0", quote: goodQuote }]));
    expect(result.voided).toEqual([{ id: "PM/9/9#p0-0", reason: "unknown-id" }]);
  });

  it("reports a passage missing from judged as unjudged", () => {
    const batch = batchFor();
    const result = verifyVerdict(batch, { judged: [passages[0]!.id, batch.canary!.id], items: [] });
    expect(result.unjudged).toEqual([passages[1]!.id]);
  });

  it("flags a batch whose positive canary was missed", () => {
    const batch = batchFor(0);
    expect(verifyVerdict(batch, fullVerdict(batch, [])).flagged).toBe(true);
  });

  it("flags a batch whose near-miss canary was matched", () => {
    const batch = batchFor(1);
    const result = verifyVerdict(batch, fullVerdict(batch, [{ id: batch.canary!.id, quote: "mentioned any silverware" }]));
    expect(result.flagged).toBe(true);
  });

  it("flags a batch whose canary was never judged", () => {
    const batch = batchFor(0);
    const result = verifyVerdict(batch, { judged: batch.passages.map((p) => p.id), items: [] });
    expect([result.flagged, result.canary?.missing]).toEqual([true, 1]);
  });

  it("trusts a batch whose canary is judged correctly and hides it from the items", () => {
    const batch = batchFor(0);
    const result = verifyVerdict(batch, fullVerdict(batch, [{ id: batch.canary!.id, quote: "lifted the Coastal Cup" }]));
    expect([result.flagged, result.items]).toEqual([false, []]);
  });
});

describe("canary scoring by claim", () => {
  type Claim = { id: string; quote: string; event: "won" | "lost" | "preview"; included?: boolean };

  const nearMiss = (event: "won" | "lost" | "preview", included?: boolean) => {
    const batch = batchFor(1);
    const item: Claim = { id: batch.canary!.id, quote: "mentioned any silverware", event, ...(included === undefined ? {} : { included }) };
    return verifyVerdict(batch, fullVerdict(batch, [item]), assertsMatch);
  };

  it("reads a near-miss canary tagged lost as seen, not a miss", () => {
    expect(nearMiss("lost").flagged).toBe(false);
  });

  it("reads a near-miss canary tagged won as a miss", () => {
    expect(nearMiss("won").flagged).toBe(true);
  });

  it("reads a near-miss canary on an excluded row as seen, even when the row says won", () => {
    expect(nearMiss("won", false).flagged).toBe(false);
  });

  it("still flags a positive canary tagged lost, which is not a claim", () => {
    const batch = batchFor(0);
    const item: Claim = { id: batch.canary!.id, quote: "lifted the Coastal Cup", event: "lost" };
    expect(verifyVerdict(batch, fullVerdict(batch, [item]), assertsMatch).flagged).toBe(true);
  });
});

describe("confirm role", () => {
  it("tells the judge to row the earliest passage of a win and refer later recaps", () => {
    expect(CONFIRM_ROLE).toMatch(/EARLIEST passage where the win happens/);
    expect(CONFIRM_ROLE).toMatch(/"referenced"/);
  });

  it("gives the judge a way to exclude a passage", () => {
    expect(CONFIRM_ROLE).toMatch(/"included": false/);
  });

  it("tells both judges to read a canary as in scope, so a book's context cannot make them reject it", () => {
    for (const role of [CONFIRM_ROLE, SCREEN_ROLE]) expect(role).toMatch(/ref is CANARY[\s\S]*read whoever it is about as in scope/);
  });
});
