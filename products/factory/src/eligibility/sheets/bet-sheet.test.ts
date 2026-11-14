import { describe, expect, it } from "vitest";
import { parseBetSheet, type BetSheetResult } from "./bet-sheet.js";
import { betLines, digests, sheetText } from "./bet-sheet.test-helpers.js";

const errorsOf = (result: BetSheetResult) => (result.ok ? [] : result.errors);

describe("parseBetSheet", () => {
  it("reads the PLAN 5.3 example shape: front matter, outcome and bets, ignoring the prose", () => {
    const result = parseBetSheet(sheetText(), digests);

    expect(result).toMatchObject({
      ok: true,
      sheet: {
        front: { initiative: "alpha", lane: "lane-a", week: "2026-W47", digest: "web" },
        outcome: { id: "alpha/phone-first", local: "phone-first" },
        bets: [{ id: "alpha/S1", outcome: "alpha/phone-first", order: 1, tasks: ["alpha/AL-1", "alpha/AL-2"], prediction: { metric: "list_p50_s", baseline: 8.4 } }],
      },
    });
  });

  it("keeps the bets in sheet order, not sorted by order", () => {
    const result = parseBetSheet(sheetText({ bets: [betLines("S2", 2), betLines("S1", 1), betLines("S3", 3)] }), digests);

    expect(result.ok && result.sheet.bets.map((bet) => bet.local)).toEqual(["S2", "S1", "S3"]);
  });

  it("accepts a bet with an empty task list and an unknown baseline", () => {
    const bets = [betLines("S1", 1, { tasks: "[]", prediction: "{ metric: m, direction: increase, baseline: null, expected: 1, read_by: 2026-11-28 }" })];

    const result = parseBetSheet(sheetText({ bets }), digests);

    expect(result).toMatchObject({ ok: true, sheet: { bets: [{ tasks: [], prediction: { baseline: null } }] } });
  });

  it("accepts a whole-initiative lane written as null", () => {
    expect(parseBetSheet(sheetText({ front: { lane: "null" } }), digests)).toMatchObject({ ok: true, sheet: { front: { lane: null } } });
  });

  it("refuses a bet citing an intent line its digest lacks, at the bet's line", () => {
    const bets = [betLines("S1", 1), betLines("S2", 2, { cites: "[{ intent_ref: web/I9, quote_ref: msg:ccc333 }]" })];
    const text = sheetText({ bets });

    const errors = errorsOf(parseBetSheet(text, digests));

    const line = text.split("\n").findIndex((row) => row.includes("web/I9")) + 1;
    expect(errors).toContainEqual({ line, message: "bet S2 cites web/I9, which is not in digest web" });
    expect(errors).toContainEqual({ line, message: "bet S2 cites no line of digest web" });
  });

  it("refuses a bet whose cites all point at another digest", () => {
    const bets = [betLines("S1", 1, { cites: "[{ intent_ref: other/I1, quote_ref: msg:ccc333 }]" })];

    expect(errorsOf(parseBetSheet(sheetText({ bets }), digests)).map((error) => error.message)).toEqual(["bet S1 cites no line of digest web"]);
  });

  it("refuses a bet with no prediction metric, pointing at the prediction line", () => {
    const bets = [betLines("S1", 1, { prediction: "{ direction: decrease, baseline: 1, expected: 0, read_by: 2026-11-28 }" })];
    const text = sheetText({ bets });

    const [error] = errorsOf(parseBetSheet(text, digests));

    expect(error?.message).toMatch(/^bet\.prediction\.metric: /);
    expect(error?.line).toBe(text.split("\n").findIndex((row) => row.startsWith("  prediction:")) + 1);
  });

  it("refuses two bets with the same order", () => {
    const errors = errorsOf(parseBetSheet(sheetText({ bets: [betLines("S1", 1), betLines("S2", 1)] }), digests));

    expect(errors.map((error) => error.message)).toEqual(["bet S2: order 1 is used by an earlier bet"]);
  });

  it("refuses a missing digest, a wrong schema, and an unknown block key", () => {
    expect(errorsOf(parseBetSheet(sheetText({ front: { digest: "nowhere" } }), digests)).map((error) => error.message)).toEqual(["digest nowhere not found"]);
    expect(errorsOf(parseBetSheet(sheetText({ front: { schema: "titan-bet-sheet/v2" } }), digests))[0]?.message).toMatch(/^front matter\.schema: /);
    expect(errorsOf(parseBetSheet(sheetText({ bets: [["selector: everything"]] }), digests))[0]?.message).toBe("a yaml block holds exactly one top-level key, `outcome` or `bet`");
  });

  it("refuses an unknown bet field rather than dropping it", () => {
    const errors = errorsOf(parseBetSheet(sheetText({ bets: [betLines("S1", 1, { state: "selected" })] }), digests));

    expect(errors.map((error) => error.message)).toEqual([expect.stringMatching(/^bet: Unrecognized key: "state"/)]);
  });

  it("refuses a sheet with no outcome block, and a non-yaml fence", () => {
    const text = sheetText().replace(/```yaml\noutcome:[\s\S]*?```\n/, "```text\nnot a block\n```\n");

    expect(errorsOf(parseBetSheet(text, digests)).map((error) => error.message)).toEqual(["a sheet holds exactly one outcome block, found 0", "only `yaml` blocks are allowed, got `text`"]);
  });

  it("keeps the front matter's lane and week on a failure so the tick can tell whose sheet failed", () => {
    expect(parseBetSheet(sheetText({ bets: [betLines("S1", 1, { prediction: null })] }), digests)).toMatchObject({ ok: false, scope: { initiative: "alpha", lane: "lane-a", week: "2026-W47" } });
  });
});
