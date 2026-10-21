import { describe, expect, it } from "vitest";
import { spokenText, triadSpans } from "./lint-register.js";
import { guardBeat, type BeatRejectionRule, type BeatRewrite } from "./rewrite-guard.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

function beatOf(spoken: string): ScriptBeat {
  const [beat] = ScriptSchema.parse(scriptWith({ spoken })).beats;
  if (!beat) throw new Error("fixture has no beat");
  return beat;
}

const rewrite = (spoken: string, labelsAdded: readonly string[]): BeatRewrite => ({ spoken, labelsAdded });

interface TriadCase {
  name: string;
  original: string;
  /** The reply shape asked to keep the item the claim turns on in the line. */
  keepOne: BeatRewrite;
  /** The reply shape asked to keep at most one item in the line and to label every item. */
  labelAll: BeatRewrite;
}

// Synthetic look-alikes of twelve rejected triad beats: the same list shapes, counts and reply moves, invented content.
const CASES: readonly TriadCase[] = [
  {
    name: "promise",
    original: "So by the end, you can name what the kitchen keeps, what it bins and what it buys. You'll also know the 9 dishes that are yours.",
    keepOne: rewrite("So by the end, you can name three things about the kitchen, and the one that matters most is what it bins. You'll also know the 9 dishes that are yours.", ["what the kitchen keeps", "what it buys"]),
    labelAll: rewrite("So by the end, you can name three things about the kitchen, and you'll also know the 9 dishes that are yours.", ["what the kitchen keeps", "what it bins", "what it buys"]),
  },
  {
    name: "stores",
    original: "The four bins are the seed tray, the compost heap, the rain barrel and the tool shed. The rota, which is the chore list on a timer, reads them. The gardener waters the beds.",
    keepOne: rewrite("There are four bins, the seed tray and the rain barrel among them, and the screen names the rest. The rota, which is the chore list on a timer, reads them all. The gardener waters the beds.", ["the compost heap", "the rain barrel", "the tool shed"]),
    labelAll: rewrite("The seed tray is one of the four bins, and the other three are on the screen. The rota, which is the chore list on a timer, reads them all, while the gardener waters the beds.", ["the compost heap", "the rain barrel", "the tool shed"]),
  },
  {
    name: "jobs",
    original: "Any bakery has seven jobs. It has to buy flour and mix it. It has to bake it and sell it. Then it must stay open, pay the staff, and be clean.",
    keepOne: rewrite("Any bakery has seven jobs. It has to buy flour and mix it, and then it has to bake it and sell it. Three more jobs follow, and the screen names them, but the last is that the bakery must be clean.", ["stay open", "pay the staff", "be clean"]),
    labelAll: rewrite("Any bakery has seven jobs. It has to buy flour and mix it, and it has to bake it and sell it. Then it has three more things to do, and the screen names them, though the first is that it must stay open.", ["stay open", "pay the staff", "be clean"]),
  },
  {
    name: "limits",
    original: "Four limits are fixed. No trucks reach the farm, so we drive to town. There are 20 crate slots. Hens molt, brood and wander. And the vet must be called rarely, and called early.",
    keepOne: rewrite("Four limits are fixed. No trucks reach the farm, so we drive to town, and crate slots are capped. Hens fail in three ways, wandering included. And the vet must be called rarely, and called early.", ["20 crate slots", "molt", "brood", "wander"]),
    labelAll: rewrite("Four limits are fixed. No trucks reach the farm, so we drive to town, and the crate slots are capped. Hens can go wrong in three ways. And the vet must be called rarely, and called early.", ["20 crate slots", "molt", "brood", "wander"]),
  },
  {
    name: "simple",
    original: "We're leaving out oven heat settings, proof time charts and glazing. Each of those is just data in a book, a card or a chart.",
    keepOne: rewrite("We're leaving out three things, glazing among them. Each one is just data, and the screen shows which of three forms it takes.", ["oven heat settings", "proof time charts", "glazing", "in a book", "in a card", "in a chart"]),
    labelAll: rewrite("We're leaving out three things the screen lists, and each one is just data that lives in one of three places.", ["oven heat settings", "proof time charts", "glazing", "a book", "a card", "a chart"]),
  },
  {
    name: "nouns",
    original: "Underneath, there are 7 tools. Spade, rake, hoe, fork and shears, trowel, sieve, and twine. Each one is a single kind of thing.",
    keepOne: rewrite("Underneath, there are 7 tools, the spade being the one to start with, and each of them is its own kind of thing.", ["spade", "rake", "hoe", "fork", "shears", "trowel", "sieve", "twine", "single kind of thing"]),
    labelAll: rewrite("Underneath, there are 7 tools, and the first is the spade, with the rest on the screen. Each is a single kind of thing.", ["rake", "hoe", "fork", "shears", "trowel", "sieve", "twine"]),
  },
  {
    name: "holds",
    original: "Paper rotas, the night-shift list and sign-out sheets give way to per-room alarms, badges and the warden.",
    keepOne: rewrite("Paper rotas, the night-shift list and sign-out sheets all give way, and the warden takes over alongside two other things the screen lists.", ["per-room alarms", "badges", "the warden"]),
    labelAll: rewrite("Paper rotas, the night-shift list and sign-out sheets all give way, and three things take their place.", ["per-room alarms", "badges", "the warden"]),
  },
  {
    name: "score",
    original: "The old checklist is gone. Two rules replace it. Ripe before green, then size and picking date.",
    keepOne: rewrite("The old checklist is gone, and two rules replace it. Ripe comes before green, and after that the screen lists what breaks ties.", ["ripe before green", "size", "picking date"]),
    labelAll: rewrite("The old checklist is gone, and two rules replace it, which order things by three criteria the screen lists.", ["ripe before green", "size", "picking date"]),
  },
  {
    name: "review",
    original: "Then comes the menu and price board, the till drawer and the order queue. After those come receipts, the cashier and alarms.",
    keepOne: rewrite("Then comes the menu and the till drawer, and after those we build three more things the screen names, with the cashier being the one that matters most.", ["menu and price board", "till drawer", "order queue", "receipts", "cashier", "alarms"]),
    labelAll: rewrite("Then comes a set of three things, and after those come three more.", ["menu and price board", "till drawer", "order queue", "receipts", "cashier", "alarms"]),
  },
  {
    name: "spices",
    original: "Last come the spices. There's the smoked salt, cumin and chili, and your house blend.",
    keepOne: rewrite("Last come the spices, and there are three of them on the screen. The one that matters is your house blend.", ["smoked salt", "cumin and chili", "house blend"]),
    labelAll: rewrite("Last come the spices, and there are three of them for you to see.", ["the smoked salt", "cumin and chili", "your house blend"]),
  },
  {
    name: "planting",
    original: "What must be planted first? The bean rows, herb bed and orchard come first. Then hives, the pond and the fence.",
    keepOne: rewrite("What must be planted first? The bean rows lead three foundations, and then hives lead the next three.", ["bean rows", "herb bed", "orchard", "hives", "pond", "fence"]),
    labelAll: rewrite("What must be planted first? The bean rows lead the way with two other pieces, and then three more follow.", ["bean rows", "herb bed", "orchard", "hives", "pond", "fence"]),
  },
  {
    name: "spices-chef",
    original: "Last come spices. There's the smoked salt, the cumin and chili, and the chef's house blend.",
    keepOne: rewrite("Last come spices, and there are three of them, including the chef's house blend.", ["smoked salt", "cumin and chili", "chef's house blend"]),
    labelAll: rewrite("Last come spices, and there are three of them.", ["the smoked salt", "the cumin and chili", "the chef's house blend"]),
  },
];

const triadsIn = (spoken: string): number => triadSpans(spokenText([spoken]).text).length;

const rulesFor = (original: string, after: BeatRewrite, ignoring: readonly BeatRejectionRule[] = []): BeatRejectionRule[] =>
  guardBeat(beatOf(original), after).map((r) => r.rule).filter((rule) => !ignoring.includes(rule));

function accepted(shape: "keepOne" | "labelAll", ignoring: readonly BeatRejectionRule[] = []): string[] {
  return CASES.filter((c) => rulesFor(c.original, c[shape], ignoring).length === 0 && triadsIn(c[shape].spoken) === 0).map((c) => c.name);
}

describe("guardBeat on triad collapses", () => {
  it("starts from originals that each hold a triad", () => {
    expect(CASES.filter((c) => triadsIn(c.original) === 0).map((c) => c.name)).toEqual([]);
  });

  it("accepts at least 8 of the 12 keep-one rewrites, each with its triad gone", () => {
    expect(accepted("keepOne").length).toBeGreaterThanOrEqual(8);
    expect(CASES.filter((c) => !accepted("keepOne").includes(c.name)).map((c) => c.name)).toEqual(["limits", "review"]);
  });

  it("rejects the label-all rewrites that keep no item and nothing their sentence said", () => {
    expect(accepted("labelAll")).toEqual(["promise", "stores", "simple", "nouns", "holds"]);
    expect(accepted("labelAll", ["list-emptied"])).toEqual(["promise", "stores", "simple", "nouns", "holds", "score", "spices", "planting"]);
    expect(accepted("keepOne", ["list-emptied"])).toEqual(accepted("keepOne"));
  });

  it("rejects the emptied spices line under the quality floor", () => {
    const spices = CASES.find((c) => c.name === "spices")!;
    expect(rulesFor(spices.original, spices.labelAll)).toEqual(["list-emptied"]);
  });

  it("rejects a label that holds only part of a list item", () => {
    const after = rewrite("Four limits are fixed. No trucks reach the farm, so we drive to town. There are 20 crate slots. Three things go wrong with them. And the vet must be called rarely, and called early.", ["hens", "brood", "wander"]);
    expect(rulesFor(CASES.find((c) => c.name === "limits")!.original, after)).toContain("list-lost");
  });

  it("does not count a pronoun one as an invented number", () => {
    const promise = CASES.find((c) => c.name === "promise")!;
    expect(rulesFor(promise.original, promise.keepOne)).toEqual([]);
    expect(rulesFor(promise.original, rewrite(promise.keepOne.spoken.replace("the one that matters most is", "one thing that matters is"), promise.keepOne.labelsAdded))).toContain("number-invented");
  });

  it("allows a short beat to grow by six words to say how many items moved", () => {
    const score = CASES.find((c) => c.name === "score")!;
    expect(rulesFor(score.original, score.keepOne)).toEqual([]);
    expect(rulesFor(score.original, rewrite(`${score.keepOne.spoken} It stays.`, score.keepOne.labelsAdded))).toContain("length");
  });

  it("does not count a word a label speaks as a dropped term", () => {
    const nouns = CASES.find((c) => c.name === "nouns")!;
    expect(rulesFor(nouns.original, nouns.keepOne)).toEqual([]);
  });

  it("finds a list item whose capture runs into the sentence's verb", () => {
    const planting = CASES.find((c) => c.name === "planting")!;
    expect(rulesFor(planting.original, planting.keepOne)).toEqual([]);
  });

  it("finds a list item whose capture starts with the sentence's verb, leaving only the long sentence", () => {
    const review = CASES.find((c) => c.name === "review")!;
    expect(rulesFor(review.original, review.keepOne)).toEqual(["sentence-cap"]);
  });

  describe("the count a collapse may say", () => {
    const BEFORE = "We skip the oven timer, glaze notes and crate labels. The bakers knead the dough.";
    const said = "We skip three things the screen lists. The bakers knead the dough.";
    const labels = ["oven timer", "glaze notes", "crate labels"];

    it("accepts the full count with every item in a label", () => {
      expect(rulesFor(BEFORE, rewrite(said, labels))).toEqual([]);
    });

    it("rejects the same rewrite with one item in no label", () => {
      expect(rulesFor(BEFORE, rewrite(said, labels.slice(0, 2)))).toEqual(expect.arrayContaining(["list-lost", "number-invented"]));
    });

    it("rejects a count that is not the list's size", () => {
      expect(rulesFor(BEFORE, rewrite(said.replace("three", "four"), labels))).toContain("number-invented");
    });

    it("accepts N more for the items moved to labels, and rejects a bare partial count", () => {
      const more = "We skip the oven timer and two more things the screen lists. The bakers knead the dough.";
      expect(rulesFor(BEFORE, rewrite(more, labels.slice(1)))).toEqual([]);
      expect(rulesFor(BEFORE, rewrite(more.replace("two more", "two"), labels.slice(1)))).toContain("number-invented");
    });

    it("still rejects a dropped term outside the list", () => {
      const after = rewrite("We skip three things the screen lists. The dough is done.", labels);
      expect(rulesFor(BEFORE, after)).toContain("terms");
    });
  });
});
