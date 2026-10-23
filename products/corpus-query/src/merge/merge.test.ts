import { describe, expect, it } from "vitest";
import { mergeRows, type SourcedRow } from "./merge.js";

function row(over: Partial<SourcedRow>): SourcedRow {
  return {
    id: "XX 1.1#p1-2@abcd1234",
    ref: "XX 1.1",
    book: "xx/1",
    order: [0, 1, 1],
    entity: "Harbour Cup",
    subject: "Northgate",
    period: "2019/20",
    detail: "2-1 v Eastby",
    role: "manager",
    quote: "q",
    event: "won",
    confidence: "sure",
    reason: "r",
    ...over,
  };
}

describe("mergeRows", () => {
  it("keeps one main-table row when a later chapter recaps the same win", () => {
    const won = row({});
    const recap = row({ id: "XX 1.9#p3-4@abcd1234", ref: "XX 1.9", order: [0, 1, 9], event: "referenced", entity: "harbour cup." });

    const merged = mergeRows([recap, won]);

    expect(merged.main).toHaveLength(1);
    expect(merged.main[0]!.ref).toBe("XX 1.1");
    expect(merged.referencedEarlier).toHaveLength(0);
  });

  it("lists a reference with no win under referenced earlier, not the main table", () => {
    const merged = mergeRows([row({ event: "referenced" })]);

    expect(merged.main).toHaveLength(0);
    expect(merged.referencedEarlier).toHaveLength(1);
  });

  it("sends unsure wins to needs ruling and drops lost and preview rows", () => {
    const merged = mergeRows([
      row({ confidence: "unsure" }),
      row({ entity: "Vale Shield", event: "lost" }),
      row({ entity: "Dale Trophy", event: "preview" }),
    ]);

    expect(merged.main).toHaveLength(0);
    expect(merged.needsRuling).toHaveLength(1);
    expect(merged.dropped).toBe(2);
  });

  it("merges judge-reported aliases into one row", () => {
    const merged = mergeRows([row({}), row({ entity: "HC", ref: "XX 1.2", order: [0, 1, 2] })], { aliases: { hc: "Harbour Cup" } });

    expect(merged.main).toHaveLength(1);
  });

  it("flags near-duplicate competitions in one period without merging them", () => {
    const merged = mergeRows([row({ entity: "Harbour Cup" }), row({ entity: "Harbor Cup", ref: "XX 1.4", order: [0, 1, 4] })]);

    expect(merged.main).toHaveLength(2);
    expect(merged.nearDuplicates).toHaveLength(1);
  });

  it("does not flag the same competition in different periods", () => {
    const merged = mergeRows([row({}), row({ period: "2020/21", ref: "XX 2.1", order: [0, 2, 1] })]);

    expect(merged.main).toHaveLength(2);
    expect(merged.nearDuplicates).toHaveLength(0);
  });

  it("infers a missing period from the book's most common one and marks it", () => {
    const merged = mergeRows([
      row({ entity: "A Cup", period: "2019/20" }),
      row({ entity: "B Cup", period: "2019/20", ref: "XX 1.2", order: [0, 1, 2] }),
      row({ entity: "C Cup", period: "", ref: "XX 1.3", order: [0, 1, 3] }),
    ]);

    const inferred = merged.main.find((r) => r.entity === "C Cup")!;
    expect(inferred.period).toBe("2019/20");
    expect(inferred.periodInferred).toBe(true);
  });

  it("sorts the main table in story order whatever the input order", () => {
    const merged = mergeRows([
      row({ entity: "Late Cup", order: [1, 1, 1], ref: "YY 1.1" }),
      row({ entity: "Early Cup", order: [0, 1, 1] }),
    ]);

    expect(merged.main.map((r) => r.entity)).toEqual(["Early Cup", "Late Cup"]);
  });
});
