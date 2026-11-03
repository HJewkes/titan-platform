import { describe, expect, it } from "vitest";
import { citedIdNumbers } from "../spoken-ids.js";
import { unspokenFacts, type ScreenText } from "./narration-facts.js";

const headline = (text: string): ScreenText => ({ text, tag: "h1", cls: "xp-headline" });
const label = (text: string): ScreenText => ({ text, tag: "span", cls: "ex-label" });

const PULL = "pr/acme/depot#6420/merged";
const TICKET = "task/TP-7001/opened";

const facts = (texts: ScreenText[], spoken: string, cited: readonly string[]) =>
  unspokenFacts("b1", texts, spoken, citedIdNumbers(cited)).map(({ kind, fact }) => `${kind}:${fact}`);

describe("a bare id number the screen shows", () => {
  it("need not be said when it is the number of a pull request the beat cites", () => {
    const texts = [headline("Cards for 6420 hold the dock queue")];

    const found = facts(texts, "the dock fix holds the queue", [PULL]);

    expect(found).toEqual([]);
  });

  it("need not be said when it is the number of a task the beat cites", () => {
    const texts = [label("7001 waits on the crane")];

    const found = facts(texts, "the stalled guard waits on the crane", [TICKET]);

    expect(found).toEqual([]);
  });

  it("must be said when the beat cites no id with that number", () => {
    const texts = [headline("Cards for 2048 hold the dock queue")];

    const found = facts(texts, "the dock fix holds the queue", [PULL]);

    expect(found).toEqual(["number:2048"]);
  });
});

describe("a real number beside a cited id", () => {
  it("must still be said", () => {
    const texts = [headline("Card 6420 refused 85 scans")];

    const found = facts(texts, "the dock fix refused scans", [PULL]);

    expect(found).toEqual(["number:85"]);
  });

  it("must still be said when it is a quantity that equals a cited id's number", () => {
    const texts = [label("$6,420 saved")];

    const found = facts(texts, "the dock fix saved money", [PULL]);

    expect(found).toEqual(["number:$6,420"]);
  });
});
