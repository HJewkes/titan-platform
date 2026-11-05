import { describe, expect, it } from "vitest";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { ask, beat, deskBeats, fakeListener, quiet } from "./listener-fakes.test-helpers.js";
import { chapterSentences, listenerVerdict, ListenerResultSchema, runListener, tallyChapter, type ListenerChapter } from "./listener-questions.js";

const c2 = () => chapterSentences(deskBeats().filter((b) => b.chapter === "c2"));

describe("hearing a chapter as sentences", () => {
  it("numbers the chapter's sentences across its beats, keeping each one's beat", () => {
    expect(c2()).toEqual([
      { id: "S1", beat: "c2-1", text: "Four checks come first: weigh, scan and label." },
      { id: "S2", beat: "c2-1", text: "Then seal." },
      { id: "S3", beat: "c2-2", text: "The courier signs the manifest before the van leaves." },
    ]);
  });

  it("keeps a closing quote with its sentence and a beat with no end mark whole", () => {
    const sentences = chapterSentences([beat("b1", "c1", 'The desk says "no." It waits'), beat("b2", "c1", "Why? Nobody asked!")]);

    expect(sentences.map((s) => s.text)).toEqual(['The desk says "no."', "It waits", "Why?", "Nobody asked!"]);
  });
});

describe("tallying one chapter's reply", () => {
  it("counts questions per sentence, with zeros, and density over the chapter's sentences", () => {
    const reply = { ...quiet(), questions: [ask("S1", "Four checks of what?"), ask("S1", "First before what?"), ask("S3", "Which manifest?")] };

    const chapter = tallyChapter("c2", c2(), reply);

    expect(chapter.sentences.map((s) => [s.id, s.questions])).toEqual([["S1", 2], ["S2", 0], ["S3", 1]]);
    expect(chapter).toMatchObject({ questions: 3, density: 1, untagged: 0, failure: null });
  });

  it("keeps a question tagged with no sentence of the chapter out of the counts, as untagged", () => {
    const chapter = tallyChapter("c2", c2(), { ...quiet(), questions: [ask("S9", "Where is the desk?"), ask("S2", "Seal what?")] });

    expect(chapter).toMatchObject({ questions: 1, untagged: 1 });
  });

  it("flags a list whose items fall in two or more sentences, in chapter order, and not one in a single sentence", () => {
    const reply = { ...quiet(), lists: [{ items: ["weigh", "scan", "label", "seal"], sentences: ["S2", "S1", "S1"] }, { items: ["weigh", "scan"], sentences: ["S1"] }] };

    expect(tallyChapter("c2", c2(), reply).flags.list_spread).toEqual([{ items: ["weigh", "scan", "label", "seal"], sentences: ["S1", "S2"] }]);
  });

  it("flags a list carried into a sentence that opens on Then, though the listener named no list", () => {
    expect(tallyChapter("c2", c2(), quiet()).flags.list_spread).toEqual([]);

    const sentences = chapterSentences([beat("b", "c1", "Five checks run: weigh, scan and label. Then seal, stamp and ship. The van leaves.")]);

    expect(tallyChapter("c1", sentences, quiet()).flags.list_spread).toEqual([{ items: ["weigh", "scan", "label", "seal", "stamp", "ship"], sentences: ["S1", "S2"] }]);
  });

  it("does not flag a Then sentence that is not itself a list, or a list the listener already named", () => {
    const plain = chapterSentences([beat("b", "c1", "Five checks run: weigh, scan and label. Then the van leaves.")]);
    const both = chapterSentences([beat("b", "c1", "Checks: weigh, scan and label. Then seal, stamp and ship.")]);
    const named = { ...quiet(), lists: [{ items: ["weigh", "ship"], sentences: ["S1", "S2"] }] };

    expect(tallyChapter("c1", plain, quiet()).flags.list_spread).toEqual([]);
    expect(tallyChapter("c1", both, named).flags.list_spread).toEqual([{ items: ["weigh", "ship"], sentences: ["S1", "S2"] }]);
  });

  it("does not count an unknown sentence toward a list's spread", () => {
    const reply = { ...quiet(), lists: [{ items: ["weigh", "seal"], sentences: ["S1", "S7"] }] };

    expect(tallyChapter("c2", c2(), reply).flags.list_spread).toEqual([]);
  });

  it("flags a term at the first sentence that speaks it, once, and drops a term the chapter never speaks", () => {
    const reply = { ...quiet(), questions: [ask("S3", "What is a manifest?", "Manifest"), ask("S3", "Who reads the manifest?", "manifest"), ask("S2", "What is a docket?", "docket")] };

    expect(tallyChapter("c2", c2(), reply).flags.terms_before_setup).toEqual([{ term: "Manifest", sentence: "S3" }]);
  });

  it("flags a term at its first sentence, earlier than the one the question named", () => {
    const sentences = chapterSentences([beat("b", "c1", "The desk runs checks. Seal it now. The checks end at noon.")]);
    const reply = { ...quiet(), questions: [ask("S3", "Which checks?", "checks")] };

    expect(tallyChapter("c1", sentences, reply).flags.terms_before_setup).toEqual([{ term: "checks", sentence: "S1" }]);
  });

  it("matches a term as whole words only", () => {
    const reply = { ...quiet(), questions: [ask("S1", "What is a can?", "can")] };

    expect(tallyChapter("c2", c2(), reply).flags.terms_before_setup).toEqual([]);
  });

  it("flags fragments the listener named and any sentence of three words or fewer, once each, in order", () => {
    const reply = { ...quiet(), fragments: ["S3", "S2", "S8", "S3"] };

    expect(tallyChapter("c2", c2(), reply).flags.fragments).toEqual(["S2", "S3"]);
    expect(tallyChapter("c2", c2(), quiet()).flags.fragments).toEqual(["S2"]);
  });

  it("does not flag a four-word sentence on its length", () => {
    expect(tallyChapter("c1", chapterSentences([beat("b", "c1", "The desk keeps ledgers.")]), quiet()).flags.fragments).toEqual([]);
  });
});

describe("running the listener over a script", () => {
  it("asks once per chapter, with only that chapter's sentences, and totals the run", async () => {
    const listener = fakeListener((sentences) => ({ ...quiet(), questions: [...sentences.keys()].map((id) => ask(id, `What about ${id}?`)) }));

    const result = await runListener({ beats: deskBeats(), judge: sonnet, harness: listener.harness });

    expect(listener.prompts).toHaveLength(2);
    expect(listener.prompts[1]).toContain("[S3] The courier signs the manifest before the van leaves.");
    expect(listener.prompts[1]).not.toContain("ledger");
    expect(result.chapters.map((c) => [c.chapter, c.questions, c.sentences.length])).toEqual([["c1", 2, 2], ["c2", 3, 3]]);
    expect(result).toMatchObject({ questions: 5, sentences: 5, density: 1, failures: [], judge: "claude-print:sonnet" });
    expect(result.spend.usd).toBeCloseTo(0.04);
    expect(ListenerResultSchema.parse(result)).toEqual(result);
  });

  it("records a failed call as an unscored chapter and keeps its spend", async () => {
    const listener = fakeListener((sentences) => (sentences.size === 3 ? "timeout" : quiet()));

    const result = await runListener({ beats: deskBeats(), judge: sonnet, harness: listener.harness });

    expect(result.failures).toEqual(["c2: timeout"]);
    expect(result.chapters[1]).toMatchObject({ failure: "timeout", questions: 0 });
    expect(result.spend.usd).toBeCloseTo(0.021);
  });

  it("changes its eval version with the judge model", async () => {
    const run = (model: string) => runListener({ beats: deskBeats(), judge: { ...sonnet, model }, harness: fakeListener(quiet).harness });

    expect((await run("sonnet")).eval_version).not.toBe((await run("opus")).eval_version);
  });
});

describe("the listener verdict", () => {
  const chapter = (name: string, questions: number, sentences: number, failure: string | null = null): ListenerChapter => ({
    chapter: name, failure, questions, untagged: 0, density: questions / sentences, asked: [],
    sentences: Array.from({ length: sentences }, (_, i) => ({ id: `S${i + 1}`, beat: "b", text: "x", questions: 0 })),
    flags: { list_spread: [{ items: ["a", "b"], sentences: ["S1", "S2"] }], terms_before_setup: [], fragments: ["S2"] },
  });
  const result = (chapters: ListenerChapter[], failures: string[] = []) => {
    const questions = chapters.reduce((n, c) => n + c.questions, 0);
    const sentences = chapters.reduce((n, c) => n + c.sentences.length, 0);
    return { chapters, questions, sentences, density: questions / sentences, failures };
  };

  it("passes with no threshold, whatever the density, and says the counts and flags", () => {
    const verdict = listenerVerdict(result([chapter("c1", 4, 2), chapter("c2", 37, 7)]));

    expect(verdict).toEqual({ pass: true, detail: "41 questions over 9 sentences (4.56 a sentence); c1 4/2, c2 37/7; flags: 2 list-spread, 0 term-before-setup, 2 fragment" });
  });

  it("fails a chapter above the threshold and names it, and passes one at it", () => {
    const run = result([chapter("c1", 4, 2), chapter("c2", 37, 7)]);

    expect(listenerVerdict(run, 2)).toMatchObject({ pass: false, detail: expect.stringMatching(/; over 2 a sentence: c2$/) });
    expect(listenerVerdict(run, 37 / 7).pass).toBe(true);
  });

  it("fails a run with an unscored chapter whatever the threshold", () => {
    const run = result([chapter("c1", 0, 2, "timeout")], ["c1: timeout"]);

    expect(listenerVerdict(run)).toMatchObject({ pass: false, detail: expect.stringMatching(/; not scored: c1: timeout$/) });
  });
});
