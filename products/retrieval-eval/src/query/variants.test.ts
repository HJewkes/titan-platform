import { describe, expect, it } from "vitest";
import { documentFrequency, headingAndLead, terms, topTermsByDf } from "./variants.js";

describe("terms", () => {
  it("drops stop words and short tokens that match everything", () => {
    expect(terms("The retrieval of a harness is on us")).toEqual(["retrieval", "harness"]);
  });

  it("splits on punctuation but keeps underscores inside a token", () => {
    expect(terms("span_fts, bm25; vacuum")).toEqual(["span_fts", "bm25", "vacuum"]);
  });

  it("drops both halves of a task ref, so TP-84 cannot be queried for", () => {
    expect(terms("see TP-84 for detail")).toEqual(["see", "detail"]);
  });
});

describe("headingAndLead", () => {
  const brief = "# Retrieval eval harness\n\nBuild a deterministic label miner over the transcripts of every session.";

  it("puts the heading in front of the lead", () => {
    expect(headingAndLead(brief)).toMatch(/^Retrieval eval harness /);
  });

  it("excludes heading text from the lead so it is not counted twice", () => {
    const query = headingAndLead(brief);
    expect(query.split("retrieval").length - 1).toBe(0);
    expect(query).toContain("deterministic label miner");
  });

  it("truncates the lead to the word budget", () => {
    const long = "# H\n\n" + Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    expect(headingAndLead(long, 5).split(" ")).toHaveLength(6);
  });

  it("works on a text with no heading at all", () => {
    expect(headingAndLead("just prose about retrieval harnesses")).toBe("just prose about retrieval harnesses");
  });
});

describe("topTermsByDf", () => {
  const corpus = [
    "retrieval harness retrieval",
    "retrieval weights tuning",
    "retrieval bootstrap loops",
    "sqlite vacuum pragma",
  ];
  const df = documentFrequency(corpus);

  it("counts a term once per document, not once per occurrence", () => {
    expect(df.get("retrieval")).toBe(3);
    expect(df.get("harness")).toBe(1);
  });

  it("prefers the rarest terms over the most common one", () => {
    const query = topTermsByDf("retrieval harness", df, 1);
    expect(query).toBe("harness");
  });

  it("treats a term absent from the corpus as the rarest there is", () => {
    expect(topTermsByDf("retrieval unseenword", df, 1)).toBe("unseenword");
  });

  it("breaks ties deterministically, so a rerun gives the same query", () => {
    const text = "vacuum pragma sqlite";
    expect(topTermsByDf(text, df, 3)).toBe(topTermsByDf(text, df, 3));
  });

  it("honours the term limit", () => {
    expect(topTermsByDf("retrieval weights tuning bootstrap loops", df, 2).split(" ")).toHaveLength(2);
  });

  it("returns an empty query for text that is all stop words", () => {
    expect(topTermsByDf("the and of it is", df)).toBe("");
  });
});
