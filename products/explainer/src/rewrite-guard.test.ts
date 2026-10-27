import { describe, expect, it } from "vitest";
import { guardBeat, rewrittenBeat, type BeatRewrite } from "./rewrite-guard.js";
import { ScriptSchema, spokenWordIndex, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const ORIGINAL =
  "The desk server checks each scan. It retries 3 times. Then it writes 12 rows to the ledger. The ledger keeps them.";

function beatWith(overrides: Record<string, unknown> = {}, spoken = ORIGINAL): ScriptBeat {
  const script = ScriptSchema.parse(scriptWith({ spoken, ...overrides }));
  const [beat] = script.beats;
  if (!beat) throw new Error("fixture has no beat");
  return beat;
}

const withCues = (cues: string[], spoken = ORIGINAL) =>
  beatWith({ visual: { assertion: "One server sits between every scanner and the ledger", job: "map", cues: cues.map((atCue) => ({ action: "V6", target: "n1", atCue })) } }, spoken);

const joined: BeatRewrite = {
  spoken: "The desk server checks each scan and retries 3 times, then it writes the rows to the ledger, which keeps them.",
  labelsAdded: ["12 rows written"],
};

const rules = (before: ScriptBeat, after: BeatRewrite, opts = {}) => guardBeat(before, after, opts).map((r) => r.rule);

describe("guardBeat", () => {
  it("accepts a joined rewrite that moves a number into a label", () => {
    expect(guardBeat(beatWith(), joined)).toEqual([]);
  });

  it("rejects a removed number that no appended label carries", () => {
    expect(rules(beatWith(), { ...joined, labelsAdded: [] })).toContain("number-lost");
  });

  it("rejects a label that only paraphrases the removed number", () => {
    expect(rules(beatWith(), { ...joined, labelsAdded: ["a dozen rows"] })).toContain("number-lost");
  });

  it("rejects a number the original never spoke", () => {
    const after = { ...joined, spoken: joined.spoken.replace("retries 3 times", "retries 7 times") };
    expect(rules(beatWith(), after)).toContain("number-invented");
  });

  describe("number-vague", () => {
    const REAL = "The desk server flags the scans. About 60 were real. The ledger keeps them.";
    const vague = { spoken: "The desk server flags the scans. Only some were real. The ledger keeps them.", labelsAdded: ["about 60 real"] };

    it("rejects a vague word standing in for a moved number", () => {
      expect(rules(beatWith({}, REAL), vague)).toContain("number-vague");
    });

    it("rejects many for a moved count of minutes", () => {
      const before = beatWith({}, "The desk server was up to 13 minutes late. The ledger keeps them.");
      const after = { spoken: "The desk server was many minutes late. The ledger keeps them.", labelsAdded: ["13 minutes late"] };
      expect(rules(before, after)).toContain("number-vague");
    });

    it.each([
      ["a number of", "The desk server flags the scans. A number of them were real. The ledger keeps them."],
      ["hundreds", "The desk server flags the scans. Hundreds were real. The ledger keeps them."],
      ["various", "The desk server flags the scans. Various ones were real. The ledger keeps them."],
    ])("rejects %s standing in for a number moved to a label", (_, spoken) => {
      const after = { spoken, labelsAdded: ["about 60 real"] };

      const rejected = rules(beatWith({}, REAL), after);

      expect(rejected).toContain("number-vague");
    });

    it("accepts the clause cut with the number in a label", () => {
      const after = { spoken: "The desk server flags the scans. The ledger keeps them.", labelsAdded: ["about 60 real"] };
      expect(rules(beatWith({}, REAL), after)).not.toContain("number-vague");
    });

    it("allows a vague word when no number left the line", () => {
      const after = { spoken: "The desk server flags some of the scans. About 60 were real. The ledger keeps them.", labelsAdded: [] };
      expect(rules(beatWith({}, REAL), after)).not.toContain("number-vague");
    });

    it("does not count a vague word the original already had", () => {
      const before = beatWith({}, "The desk server flags some scans. About 60 were real. The ledger keeps them.");
      const after = { spoken: "The desk server flags some scans. The ledger keeps them.", labelsAdded: ["about 60 real"] };
      expect(rules(before, after)).not.toContain("number-vague");
    });
  });

  describe("closer-added", () => {
    const LONG_LAST = "The desk server checks each scan. Then it writes every checked row to the ledger before the courier asks.";

    it("rejects a rewrite that ends on a new short summing-up line", () => {
      const after = { spoken: `${LONG_LAST} That is the whole point.`, labelsAdded: [] };

      const rejected = rules(beatWith({}, LONG_LAST), after);

      expect(rejected).toContain("closer-added");
    });

    it("accepts a rewrite that ends on a short line the original already said", () => {
      const before = beatWith({}, "Nothing is lost. The desk server checks each scan and writes every checked row to the ledger.");
      const after = { spoken: "The desk server checks each scan and writes every checked row to the ledger. Nothing is lost.", labelsAdded: [] };

      expect(rules(before, after)).not.toContain("closer-added");
    });

    it("accepts a new short last line when the original already ended on its shortest", () => {
      const before = beatWith({}, "The desk server checks each scan and writes the rows to the ledger. Then it prints.");
      const after = { spoken: "The desk server checks each scan and writes the rows to the ledger. It then prints.", labelsAdded: [] };

      expect(rules(before, after)).not.toContain("closer-added");
    });

    it("accepts a rewrite whose new last line is not its shortest", () => {
      const after = { spoken: "It checks. The desk server writes every checked row to the ledger before the courier asks.", labelsAdded: [] };

      expect(rules(beatWith({}, LONG_LAST), after)).not.toContain("closer-added");
    });
  });

  describe("device-added", () => {
    const PLAIN = "The desk server checks each scan. The ledger keeps the rows. Nobody retypes them.";
    const COLONED = "The desk server checks each scan. The ledger keeps one thing: the rows. Nobody retypes them.";

    it("rejects a Y, not X tail the original lacked", () => {
      const after = { spoken: "The desk server checks each scan. The ledger keeps the rows, not by hand.", labelsAdded: [] };
      expect(rules(beatWith({}, PLAIN), after)).toContain("device-added");
    });

    it("rejects a semicolon the original lacked", () => {
      const after = { spoken: "The desk server checks each scan; the ledger keeps the rows. Nobody retypes them.", labelsAdded: [] };
      expect(rules(beatWith({}, PLAIN), after)).toContain("device-added");
    });

    it("rejects a colon reveal the original lacked", () => {
      const after = { spoken: "The desk server checks each scan. The ledger keeps one thing: the rows. Nobody retypes them.", labelsAdded: [] };
      expect(rules(beatWith({}, PLAIN), after)).toContain("device-added");
    });

    it("rejects a let's the original lacked", () => {
      const after = { spoken: "Let's see how the desk server checks each scan. The ledger keeps the rows. Nobody retypes them.", labelsAdded: [] };
      expect(rules(beatWith({}, PLAIN), after)).toContain("device-added");
    });

    it("accepts a rewrite that keeps an existing colon", () => {
      const after = { spoken: "The desk server checks every scan. The ledger keeps one thing: the rows. Nobody retypes them.", labelsAdded: [] };
      expect(rules(beatWith({}, COLONED), after)).not.toContain("device-added");
    });

    it("accepts a rewrite that drops a device", () => {
      expect(rules(beatWith({}, COLONED), { spoken: PLAIN, labelsAdded: [] })).not.toContain("device-added");
    });
  });

  it("rejects a rewrite that drops a cue word", () => {
    const before = withCues(["ledger"]);
    const after = { ...joined, spoken: joined.spoken.replace(/ledger/g, "store") };
    expect(rules(before, after)).toContain("cue-lost");
  });

  it("rejects cues that land in a different order", () => {
    const before = withCues(["server", "ledger"]);
    const after = { ...joined, spoken: "The ledger keeps rows that the desk server checks on each scan, retries 3 times and writes." };
    expect(rules(before, after)).toContain("cue-order");
  });

  it("accepts cues that keep their order", () => {
    expect(guardBeat(withCues(["server", "ledger"]), joined)).toEqual([]);
  });

  it("rejects a rewrite that stops speaking a new term", () => {
    const before = beatWith({ new_terms: ["ledger"] });
    const after = { ...joined, spoken: joined.spoken.replace(/ledger/g, "store") };
    expect(rules(before, after)).toContain("new-term");
  });

  const longSentence =
    "The desk server checks each scan and retries 3 times before it writes the rows to the ledger, which keeps them so that every courier sees the same state afterwards.";

  it("rejects a sentence over the cap when no speech verdict is given", () => {
    const after = { spoken: longSentence, labelsAdded: ["12 rows written"] };
    expect(rules(beatWith(), after)).toContain("sentence-cap");
  });

  it("accepts that sentence when the speech verdict calls it clean", () => {
    const after = { spoken: longSentence, labelsAdded: ["12 rows written"] };
    expect(rules(beatWith(), after, { speechClean: () => true })).not.toContain("sentence-cap");
  });

  it("honours an injected vetted ceiling", () => {
    const after = { spoken: longSentence, labelsAdded: ["12 rows written"] };
    expect(rules(beatWith(), after, { speechClean: () => true, maxVettedSentenceWords: 26 })).toContain("sentence-cap");
  });

  it("rejects altered markup", () => {
    const before = beatWith({}, "The [ledger](=led-jer) keeps every scan. It retries 3 times. It stays small.");
    const after = { spoken: "The ledger keeps every scan and retries 3 times. It stays small.", labelsAdded: [] };
    expect(rules(before, after)).toContain("markup");
  });

  it("rejects an empty rewrite", () => {
    expect(rules(beatWith(), { spoken: "  ", labelsAdded: [] })).toContain("empty");
  });

  it("rejects a moved-number label that is a bare number", () => {
    expect(rules(beatWith(), { ...joined, labelsAdded: ["12"] })).toContain("label-bare");
  });

  it("rejects a moved-number label that is a bare number word", () => {
    const before = beatWith({}, "The desk server checks each scan. It retries four times. The ledger keeps them all.");
    const after = { spoken: "The desk server checks each scan and retries a few times. The ledger keeps them all.", labelsAdded: ["Four"] };
    expect(rules(before, after)).toContain("label-bare");
  });

  it("accepts a label that carries its noun phrase", () => {
    expect(rules(beatWith(), joined)).not.toContain("label-bare");
  });

  const LISTED = "The desk reads the Alder store, the Birch store, and the Cedar store. It writes them all to the ledger. The ledger keeps them.";

  it("rejects a named list removed from spoken and absent from the labels", () => {
    const after = { spoken: "The desk reads three stores and writes them all to the ledger. The ledger keeps them.", labelsAdded: [] };
    expect(rules(beatWith({}, LISTED), after)).toContain("list-lost");
  });

  it("accepts a named list moved into the labels", () => {
    const after = {
      spoken: "The desk reads three stores and writes them all to the ledger. The ledger keeps them.",
      labelsAdded: ["Alder store", "Birch store", "Cedar store"],
    };
    expect(rules(beatWith({}, LISTED), after)).not.toContain("list-lost");
  });

  it("rejects a removed number whose label holds a different number", () => {
    expect(rules(beatWith(), { ...joined, labelsAdded: ["120 rows written"] })).toContain("number-lost");
  });

  it("does not count a new term as spoken when only a longer word holds it", () => {
    const before = beatWith({ new_terms: ["led"] }, "The led shows each scan. It retries 3 times. It stays small.");
    const after = { spoken: "The ledger shows each scan and retries 3 times. It stays small.", labelsAdded: [] };
    expect(rules(before, after)).toContain("new-term");
  });

  it("does not find a lost list item inside a longer word", () => {
    const before = beatWith({}, "The desk reads the Alder store, the Birch store, and the Cedar store. It writes them all. The ledger keeps them.");
    const after = { spoken: "The desk reads three stores. Alderman writes them all. The ledger keeps them.", labelsAdded: [] };
    expect(rules(before, after)).toContain("list-lost");
  });

  it("does not count the words of a number moved into a label as dropped terms", () => {
    const before = beatWith({}, "The desk ledger can hold 5000 rows before it rolls over.");
    const after = { spoken: "The desk ledger keeps its rows until it rolls over.", labelsAdded: ["5000 rows"] };
    expect(guardBeat(before, after)).toEqual([]);
  });

  it("still rejects a moved number's rewrite that drops a real content term as well", () => {
    const before = beatWith({}, "The desk ledger can hold 5000 rows before it rolls over.");
    const after = { spoken: "The ledger keeps its rows until it rolls over.", labelsAdded: ["5000 rows"] };
    expect(rules(before, after)).toEqual(["terms"]);
  });

  describe("with a spelled number moved to a digit label", () => {
    const SPELLED = "The factory had twenty-eight implementer slots this morning. It filled almost none of them.";
    const MOVED = "The factory had spare implementer slots this morning, and it filled almost none of them.";

    it("accepts the label written in digits", () => {
      expect(guardBeat(beatWith({}, SPELLED), { spoken: MOVED, labelsAdded: ["28 slots"] })).toEqual([]);
    });

    it("accepts a spelled hundred read with an and", () => {
      const before = beatWith({}, "A hundred and ninety tasks were marked ready, and the tick dispatched none of them.");
      const after = { spoken: "The tasks were marked ready, and the tick dispatched none of them.", labelsAdded: ["190 tasks ready"] };
      expect(guardBeat(before, after)).toEqual([]);
    });

    it("accepts a number said after an article moved to a label", () => {
      const before = beatWith({}, "The worker runs under a five-hour ceiling, and the desk stops it there.");
      const after = { spoken: "The worker runs under a ceiling, and the desk stops it there.", labelsAdded: ["five-hour ceiling"] };
      expect(guardBeat(before, after)).toEqual([]);
    });

    describe("from a spelled range", () => {
      const RANGE = "About thirty to thirty-five percent of heads stall on the first try.";

      it("accepts a label that carries both ends", () => {
        const after = { spoken: "A share of the heads stall on the first try.", labelsAdded: ["thirty to thirty-five percent of heads"] };
        expect(guardBeat(beatWith({}, RANGE), after)).toEqual([]);
      });

      it("rejects a line that keeps only the upper end", () => {
        const after = { spoken: "About thirty-five percent of heads stall on the first try.", labelsAdded: ["thirty percent"] };
        expect(rules(beatWith({}, RANGE), after)).toContain("number-lost");
      });
    });

    it("still rejects the number when the label holds a different one, or none", () => {
      expect(rules(beatWith({}, SPELLED), { spoken: MOVED, labelsAdded: ["27 slots"] })).toContain("number-lost");
      expect(rules(beatWith({}, SPELLED), { spoken: MOVED, labelsAdded: [] })).toContain("number-lost");
    });

    it("rejects a digit rewrite of a spelled number that changes its value", () => {
      const after = { spoken: SPELLED.replace("twenty-eight", "29"), labelsAdded: [] };
      expect(rules(beatWith({}, SPELLED), after)).toEqual(expect.arrayContaining(["number-lost", "number-invented"]));
    });

    it("keeps a cue on the moved number by landing it on the label's noun the line still speaks", () => {
      const before = withCues(["twenty-eight"], SPELLED);
      const after = { spoken: MOVED, labelsAdded: ["28 slots"] };

      const beat = rewrittenBeat(before, after);

      expect(guardBeat(before, after)).toEqual([]);
      expect(beat.visual.cues.map((cue) => cue.atCue)).toEqual(["slots"]);
      expect(spokenWordIndex(beat)("slots")).toBe(MOVED.split(" ").indexOf("slots"));
      expect(beat.visual.labels).toEqual(["28 slots"]);
    });

    it("lands that cue on a later noun of the label when the line does not speak the first", () => {
      const after = { spoken: MOVED, labelsAdded: ["28 open slots"] };
      expect(rewrittenBeat(withCues(["twenty-eight"], SPELLED), after).visual.cues.map((cue) => cue.atCue)).toEqual(["slots"]);
    });

    it("rejects that cue when the line no longer speaks the label's noun", () => {
      const after = { spoken: MOVED.replace("implementer slots", "implementer seats"), labelsAdded: ["28 slots"] };
      expect(rules(withCues(["twenty-eight"], SPELLED), after)).toContain("cue-lost");
    });
  });
});

describe("guardBeat entities and inherited sentences", () => {
  const WITH_ID = "The desk server checks each scan. M10 shrinks the charter. The ledger keeps them.";
  const moved = (labelsAdded: string[]): BeatRewrite => ({
    spoken: "The desk server checks each scan. The charter shrinks. The ledger keeps them.",
    labelsAdded,
  });

  it("accepts an entity moved to an appended label", () => {
    expect(rules(beatWith({}, WITH_ID), moved(["M10 shrinks the charter"]))).not.toContain("entity");
  });

  it("rejects a dropped entity that no label carries", () => {
    expect(rules(beatWith({}, WITH_ID), moved([]))).toContain("entity");
  });

  it("does not let a longer id in a label carry a shorter one", () => {
    const before = beatWith({}, WITH_ID.replace("M10", "F1"));
    expect(rules(before, moved(["F12 shrinks the charter"]))).toContain("entity");
  });

  describe("sentence-cap", () => {
    const LONG = `The desk server ${"checks each scan and then ".repeat(6)}writes the rows`;
    const before = beatWith({}, `${LONG}. The ledger keeps them.`);

    it("exempts a long sentence copied unchanged from the original", () => {
      const after = { spoken: `${LONG}. The ledger holds them.`, labelsAdded: [] };
      expect(rules(before, after)).not.toContain("sentence-cap");
    });

    it("rejects the same long sentence with one word changed", () => {
      const after = { spoken: `${LONG.replace("writes", "stores")}. The ledger keeps them.`, labelsAdded: [] };
      expect(rules(before, after)).toContain("sentence-cap");
    });
  });
});
