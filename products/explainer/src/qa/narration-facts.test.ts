import { describe, expect, it } from "vitest";
import { narrationFactsReport, spokenValues, unspokenFacts, type ScreenText } from "./narration-facts.js";

const headline = (text: string): ScreenText => ({ text, tag: "h1", cls: "xp-headline" });
const label = (text: string, cls = "ex-label"): ScreenText => ({ text, tag: "span", cls });
const facts = (texts: ScreenText[], spoken: string) => unspokenFacts("b1", texts, spoken).map(({ kind, fact }) => `${kind}:${fact}`);

describe("spoken values", () => {
  it("reads numbers spoken in words and in digits as one value each", () => {
    const spoken = "forty percent of a hundred and twenty parcels, twelve hundred in all, and 7 lanes";

    const values = spokenValues(spoken);

    expect([...values].sort((a, b) => a - b)).toEqual([7, 40, 120, 1200]);
  });

  it("reads an article as a number only before a scale word", () => {
    const values = spokenValues("a lane holds a thousand parcels");

    expect([...values]).toEqual([1000]);
  });
});

describe("narration carries on-screen facts", () => {
  it("matches written and spoken forms of the same number", () => {
    const texts = [headline("40% of parcels wait"), label("1.2k parcels"), label("$1.4M saved")];

    const found = facts(texts, "forty percent of parcels wait; twelve hundred parcels; one point four million saved");

    expect(found).toEqual([]);
  });

  it("flags a headline number and a label number the narration never says", () => {
    const texts = [headline("60% of parcels wait"), label("85 lanes")];

    const found = facts(texts, "most parcels wait at the desk");

    expect(found).toEqual(["number:60%", "number:85"]);
  });

  it("accepts a number the narration rounds to two significant figures", () => {
    const found = facts([label("1,247 parcels")], "about twelve hundred parcels");

    expect(found).toEqual([]);
  });

  it("leaves out axis ends, step markers, beat numbers and years outside the headline", () => {
    const texts = [label("0", "ex-axis-floor"), label("3", "ex-step-marker"), label("Beat 4"), label("since 2019")];

    const found = facts(texts, "the desk sorts parcels");

    expect(found).toEqual([]);
  });

  it("leaves out the numbers of a source citation", () => {
    const texts = [label("desk-notes-2031-02-14.md §2.4, steps 1-2"), label("ledger.tsv line 252")];

    const found = facts(texts, "the desk sorts parcels");

    expect(found).toEqual([]);
  });

  it("flags a year when the headline makes it the claim", () => {
    const found = facts([headline("The desk opened in 2019")], "the desk opened years ago");

    expect(found).toEqual(["number:2019"]);
  });

  it("takes only a chart's largest value as its finding", () => {
    const bars = [label("12", "ex-bar-value"), label("48", "ex-bar-value"), label("30", "ex-bar-value")];

    const found = facts(bars, "the parcel lane is slowest");

    expect(found).toEqual(["number:48"]);
  });

  it("flags a headline name the narration never says, and passes one it does", () => {
    const texts = [headline("Most parcels stop at Harbor"), headline("The Relay lane sorts first")];

    const found = facts(texts, "most parcels stop at the dock, and the relay lane sorts first");

    expect(found).toEqual(["name:Harbor"]);
  });

  it("reads only identifier-shaped words as names in a title-cased headline", () => {
    const found = facts([headline("Parcels Wait Behind The SortGate Queue")], "parcels wait behind the gate");

    expect(found).toEqual(["name:SortGate"]);
  });

  it("hears an acronym spelled out or expanded, a compound read apart and a marker's number", () => {
    const texts = [headline("Every parcel passes QA"), headline("The desk reads SortGate"), headline("Each PR waits"), headline("Q2: who sorts")];

    const found = facts(texts, "every parcel passes Q A, the desk reads sort gate, each pull request waits; question two asks who sorts");

    expect(found).toEqual([]);
  });
});

describe("narration facts report", () => {
  it("joins a beat's moments, keeps each fact once, and names its beat", () => {
    const moments = [
      { beat: "b1", texts: [headline("60% wait")] },
      { beat: "b1", texts: [headline("60% wait")] },
      { beat: "b2", texts: [headline("Lanes sort parcels")] },
    ];

    const report = narrationFactsReport(moments, (beat) => (beat === "b2" ? "lanes sort parcels" : "most wait"));

    expect(report).toEqual({ beats: 2, findings: [{ beat: "b1", kind: "number", fact: "60%", shown: "60% wait" }] });
  });
});
