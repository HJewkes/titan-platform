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

  it("hears a decision number said in pairs as the whole number", () => {
    const values = spokenValues("Decision five thirty-one stands");

    expect([...values]).toEqual(expect.arrayContaining([531]));
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

  it("hears a list marker by its place, so Q1 opened with 'first' is said and Q3 left unplaced is not", () => {
    // Arrange
    const texts = [headline("Q1: which desk sorts"), headline("Q3: when lanes close")];

    // Act
    const found = facts(texts, "first, which desk sorts; then when the lanes close");

    // Assert
    expect(found).toEqual(["name:Q3"]);
  });
});

describe("scaffolding and citations", () => {
  it("a chapter counter's numbers are not claims", () => {
    // Arrange
    const texts = [label("3", "xp-chapter-count"), label("8", "xp-chapter-count")];

    // Act
    const found = facts(texts, "the desk sorts parcels");

    // Assert
    expect(found).toEqual([]);
  });

  it("a PR number in a row cites its source", () => {
    // Arrange
    const texts = [label("PR 2312 sorted the desk"), label("fixed in #88"), label("see ABC-4467")];

    // Act
    const found = facts(texts, "the desk sorts parcels");

    // Assert
    expect(found).toEqual([]);
  });

  it("nothing merged is heard as zero", () => {
    // Arrange
    const texts = [label("Guardrails 0")];

    // Act
    const found = facts(texts, "nothing moved toward its guardrails goal");

    // Assert
    expect(found).toEqual([]);
  });

  it("only an upper-case task id cites a task", () => {
    const texts = [label("top-10 lanes"), label("COVID-19 sorts"), label("ABC-4467 closed")];

    const found = facts(texts, "the desk sorts parcels");

    expect(found).toEqual(["number:10", "number:19"]);
  });

  it("a shown zero is still flagged when the narration says neither zero nor nothing", () => {
    const found = facts([label("Guardrails 0")], "the guardrails goal moved");

    expect(found).toEqual(["number:0"]);
  });
});

describe("narration facts report", () => {
  it("a counting figure is judged by the value it settles on", () => {
    // Arrange
    const tile = (value: string) => ({ ...label(value, "ex-stat"), element: "div.tile", lines: [{ x: 40, y: 300, width: 80, height: 40 }] });
    const moments = ["5", "19", "23", "32"].map((value) => ({ beat: "b1", texts: [tile(value)] }));

    // Act
    const report = narrationFactsReport(moments, () => "thirty-two lanes");

    // Assert
    expect(report.findings).toEqual([]);
  });

  it("a number changing in an element with no probed position is plain text, not a count", () => {
    // Arrange
    const tile = (value: string) => ({ ...label(value, "ex-stat"), element: "div.tile" });
    const moments = ["5", "19", "33"].map((value) => ({ beat: "b1", texts: [tile(value)] }));

    // Act
    const report = narrationFactsReport(moments, () => "thirty-two lanes");

    // Assert
    expect(report.findings.map((finding) => finding.fact)).toEqual(["5", "19", "33"]);
  });

  it("sibling figures sharing an element description are each judged", () => {
    // Arrange
    const figure = (value: string) => ({ ...label(value, "ex-stat"), element: "span.ex-stat" });
    const moments = [{ beat: "b1", texts: [figure("12"), figure("40"), figure("7")] }];

    // Act
    const report = narrationFactsReport(moments, () => "seven lanes");

    // Assert
    expect(report.findings.map((finding) => finding.fact)).toEqual(["12", "40"]);
  });

  it("a chart's largest bar stays the claim when smaller bars follow it", () => {
    const bar = (value: string) => ({ ...label(value, "ex-bar-value"), element: "span.ex-bar-value" });
    const moments = [{ beat: "b1", texts: [bar("48"), bar("12"), bar("30")] }];

    const report = narrationFactsReport(moments, () => "the parcel lane is slowest");

    expect(report.findings.map((finding) => finding.fact)).toEqual(["48"]);
  });

  it("figures that appear one after another in one element are all judged", () => {
    const figure = (value: string) => ({ ...label(value, "ex-stat"), element: "span.ex-stat" });
    const moments = [{ beat: "b1", texts: [figure("12")] }, { beat: "b1", texts: [figure("12"), figure("40")] }];

    const report = narrationFactsReport(moments, () => "forty lanes");

    expect(report.findings.map((finding) => finding.fact)).toEqual(["12"]);
  });

  it("figures at different places in one element are not one counting figure", () => {
    const at = (value: string, x: number) => ({ ...label(value, "ex-stat"), element: "span.ex-stat", lines: [{ x, y: 100, width: 40, height: 20 }] });
    const moments = [{ beat: "b1", texts: [at("12", 100)] }, { beat: "b1", texts: [at("40", 600)] }];

    const report = narrationFactsReport(moments, () => "forty lanes");

    expect(report.findings.map((finding) => finding.fact)).toEqual(["12"]);
  });

  it("a counting figure that settles on an unspoken value is flagged once", () => {
    const tile = (value: string) => ({ ...label(value, "ex-stat"), element: "div.tile", lines: [{ x: 40, y: 300, width: 80, height: 40 }] });
    const moments = ["5", "19", "33"].map((value) => ({ beat: "b1", texts: [tile(value)] }));

    const report = narrationFactsReport(moments, () => "thirty-two lanes");

    expect(report.findings).toEqual([{ beat: "b1", kind: "number", fact: "33", shown: "33" }]);
  });

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
