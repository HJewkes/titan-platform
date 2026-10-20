import { describe, expect, it } from "vitest";
import { LabelsSchema } from "./eval-calibrate.js";
import {
  agreedOddOnes,
  coldEvalVersion,
  coldQuestions,
  coldTerms,
  readerGapScores,
  runCold,
  spokenTranscript,
  type ColdInput,
} from "./eval-cold.js";
import { agreedTerms, termKey } from "./eval-cold-terms.js";
import { readRubric } from "./eval-evidence.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { paceInput } from "./eval-pace-cli.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { buildPaceBeats, type PaceBeat, type PaceSourceBeat } from "./pace-items.js";
import { v4Durations, v4FullScript, v4Labels } from "./spike-fixtures.test-helpers.js";
import { readTiming } from "./timing.js";

const rubric = readRubric("l1-cold.md");

const source = (id: string, chapter: string, spoken: string, cues: string[], plannedS: number): PaceSourceBeat => ({
  id,
  chapter,
  fn: "WHAT",
  spoken,
  plannedS,
  mapBeside: false,
  cues: cues.map((target) => ({ target })),
  titles: [],
  reveals: [],
  pins: [],
  cards: [],
  terms: [],
});

/** An invented parcel desk: ch1 lists three jobs and states an invariant, ch2 reuses one job and adds the ledger. */
const track = (): PaceBeat[] =>
  buildPaceBeats([
    source("c1-1", "ch1", "The desk does three jobs for every parcel that comes in.", ["job:scan", "job:weigh", "job:label"], 9),
    source("c1-2", "ch1", "Each parcel gets exactly one label, because a second label ships twice.", ["inv:one label per parcel"], 6),
    source("c2-1", "ch2", "Every scan lands in the ledger, which the billing team reads nightly.", ["job:scan", "card:ledger"], 8),
    source("c2-2", "ch2", "The ledger refuses a parcel that was never scanned.", ["detail:refuses unscanned"], 4),
  ]);

const CH1_ONLY = ["three jobs for every parcel", "exactly one label", "weigh", "one label per parcel"];

interface PromptQuestion {
  qid: string;
  text: string;
}

const promptQuestions = (prompt: string): PromptQuestion[] =>
  [...prompt.matchAll(/^- (q\d+): (.*)$/gm)].map((m) => ({ qid: m[1]!, text: m[2]! }));

const promptBeats = (prompt: string): { id: string; spoken: string }[] =>
  [...prompt.matchAll(/^\[([^\]]+)\] from .*\nspoken: (.*)$/gm)].map((m) => ({ id: m[1]!, spoken: m[2]! }));

const quoteOf = (text: string, from = 0): string => text.split(" ").slice(from, from + 3).join(" ");

interface ViewerOptions {
  why?: "found" | "none" | "invented" | "other-chapter";
  inventWhat?: boolean;
  answerCanary?: boolean;
  notStated?: boolean;
  summary?: string;
  fail?: number;
  oddPick?: string | null;
}

/** A viewer that quotes the chapter's first beat; options make it skip, invent or misplace its quotes. */
function fakeViewer(options: ViewerOptions = {}) {
  const calls: string[] = [];
  let firstChapterBeat = { id: "", spoken: "" };
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    if (options.fail === calls.length) return { ok: false, reason: "timeout: no reply", usd: 0, tokensIn: 0, tokensOut: 0 };
    const first = promptBeats(prompt)[0]!;
    if (calls.length === 1) firstChapterBeat = first;
    const whyQuote = {
      found: [{ beat: first.id, quote: quoteOf(first.spoken, 3) }],
      none: [],
      invented: [{ beat: first.id, quote: "a sentence nobody spoke" }],
      "other-chapter": [{ beat: firstChapterBeat.id, quote: quoteOf(firstChapterBeat.spoken) }],
    }[options.why ?? "found"];
    const answers = promptQuestions(prompt).map(({ qid, text }) => {
      const blank = (options.notStated ?? false) || (text.includes('"relay-') && !options.answerCanary);
      return {
        qid,
        not_stated: blank,
        what: blank ? "" : "a thing the desk does",
        what_quotes: blank ? [] : [{ beat: first.id, quote: options.inventWhat ? "a sentence nobody spoke" : quoteOf(first.spoken) }],
        why: blank ? "" : "so parcels ship once",
        why_quotes: blank ? [] : whyQuote,
        odd_one_out: options.oddPick ?? null,
      };
    });
    const output = { answers, summary: options.summary ?? `I saw chapter ${calls.length}.` };
    return { ok: true, output: schema.parse(output), usd: 0.02, tokensIn: 300, tokensOut: 60 };
  };
  return { harness, calls };
}

const input = (harness: JudgeHarness, run = 1): ColdInput => ({ scriptSha: "s".repeat(64), beats: track(), rubric, judge: sonnet, harness, run });

const chapterScores = async (options: ViewerOptions) => (await runCold(input(fakeViewer(options).harness))).chapters;

describe("the spoken transcript", () => {
  it("gives each beat's spoken words and end on the chapter's clock", () => {
    const [a, b] = track();

    const text = spokenTranscript([{ ...a!, durationS: 4 }, { ...b!, durationS: 4.5 }]);

    expect(text).toBe(
      "[c1-1] from 0.0 s\nspoken: The desk does three jobs for every parcel that comes in.\nbeat ends at 4.0 s\n\n" +
        "[c1-2] from 4.0 s\nspoken: Each parcel gets exactly one label, because a second label ships twice.\nbeat ends at 8.5 s",
    );
  });

  // Mutation: putting the screen back lets a card's label explain a word the narration never does (TP-3807).
  it("shows the viewer no on-screen label in either cold prompt", async () => {
    const beats = buildPaceBeats([source("s1-1", "ch1", "The sorter hands each parcel on.", ["card:sorter", "detail:belt robot"], 6)]);
    const cold = fakeViewer();
    const terms = termsViewer([[], [], []]);

    await runCold({ ...input(cold.harness), beats });
    await coldTerms({ beats, rubric: termsRubric, harness: terms.harness });

    for (const prompt of [...cold.calls, ...terms.calls]) {
      expect(prompt).toContain("spoken: The sorter hands each parcel on.");
      expect(prompt).not.toContain("belt robot");
      expect(prompt).not.toContain("on screen:");
    }
  });
});

describe("the streamed cold-viewer probe", () => {
  // Mutation: passing the full transcript to every call puts ch1's words into ch2's prompt.
  it("gives chapter 2 no chapter 1 text except the viewer's summary, clamped to three lines", async () => {
    const viewer = fakeViewer({ summary: "line one\nline two\n\nline three\nline four" });

    await runCold(input(viewer.harness));

    expect(viewer.calls).toHaveLength(2);
    const [ch1 = "", ch2 = ""] = viewer.calls;
    expect(ch2).toContain("line one\nline two\nline three");
    expect(ch2).not.toContain("line four");
    for (const text of CH1_ONLY) expect(ch2).not.toContain(text);
    expect(ch1).not.toContain("billing team");
    expect(ch1).toContain("Nothing yet: this is the first chapter.");
  });

  // Mutation: a hard-coded question list stops matching the track's new items.
  it("asks what and why of exactly the track's new items, plus invariants, odd-one-out lists and one canary", async () => {
    const beats = track();
    const viewer = fakeViewer();

    await runCold(input(viewer.harness));

    const whatWhy = coldQuestions(beats).flatMap((q) => (q.kind === "what-why" ? [q.item] : []));
    expect(whatWhy).toEqual(beats.flatMap((b) => b.newItems.map((i) => i.label)));
    expect(whatWhy).toEqual(["scan", "weigh", "label", "one label per parcel", "ledger"]);
    expect(coldQuestions(beats).filter((q) => q.kind !== "what-why")).toMatchObject([
      { kind: "odd-one-out", beat: "c1-1", items: ["scan", "weigh", "label"] },
      { kind: "invariant", beat: "c1-2", item: "one label per parcel" },
    ]);
    const ch2 = promptQuestions(viewer.calls[1]!).map((q) => q.text);
    expect(ch2).toEqual(expect.arrayContaining([expect.stringContaining('"ledger"'), expect.stringContaining('"relay-')]));
    expect(ch2).toHaveLength(2);
  });

  it("scores 2 for what and why quoted from this chapter, 1 for what only", async () => {
    expect((await chapterScores({ why: "found" }))[0]!.scores.map((s) => s.score)).toEqual([2, 2, 2, 2, 2]);
    expect((await chapterScores({ why: "none" }))[0]!.scores.map((s) => s.score)).toEqual([1, 1, 1, 1, 1]);
  });

  // Mutation: grading without voidReason lets an invented or out-of-chapter quote score 2.
  it("scores 0 when a quote is not found in this chapter's spoken words", async () => {
    const invented = (await chapterScores({ why: "invented" }))[0]!.scores[0]!;
    const misplaced = (await chapterScores({ why: "other-chapter" }))[1]!.scores[0]!;
    const noWhat = (await chapterScores({ why: "found", inventWhat: true }))[0]!.scores[0]!;

    expect(invented).toMatchObject({ score: 0, void_reason: "quote not found in c1-1" });
    expect(misplaced).toMatchObject({ score: 0, void_reason: "cites unknown beat c1-1" });
    expect(noWhat).toMatchObject({ score: 0, void_reason: "quote not found in c1-1" });
  });

  it("reports undefined items per chapter minute", async () => {
    const [ch1, ch2] = await chapterScores({ notStated: true });

    expect(ch1).toMatchObject({ minutes: 0.25, undefined_items: 4, undefined_per_minute: 16 });
    expect(ch2).toMatchObject({ undefined_items: 1, undefined_per_minute: 5 });
  });

  it("trusts a run whose viewer declines every canary item, and not one that answers it", async () => {
    const careful = await runCold(input(fakeViewer().harness));
    const guesser = await runCold(input(fakeViewer({ answerCanary: true }).harness));

    expect(careful.trusted).toBe(true);
    expect(careful.chapters.map((c) => c.canary.pass)).toEqual([true, true]);
    expect(guesser.trusted).toBe(false);
    expect(guesser.chapters.map((c) => c.canary.got)).toEqual(["answered", "answered"]);
  });

  // Mutation: recording a placeholder per chapter instead of the label the viewer was asked about.
  it("records each chapter's canary under the relay label its prompt asked about", async () => {
    const viewer = fakeViewer();

    const result = await runCold(input(viewer.harness));

    const asked = viewer.calls.map((prompt) => /"(relay-[0-9a-f]{6})"/.exec(prompt)?.[1]);
    expect(asked).toEqual([expect.stringMatching(/^relay-[0-9a-f]{6}$/), expect.stringMatching(/^relay-[0-9a-f]{6}$/)]);
    expect(result.chapters.map((c) => c.canary.canary)).toEqual(asked);
  });

  it("does not trust a run with a failed call, and carries the last good summary past it", async () => {
    const viewer = fakeViewer({ fail: 1 });

    const result = await runCold(input(viewer.harness));

    expect(result.trusted).toBe(false);
    expect(result.failures).toEqual(["timeout: no reply"]);
    expect(result.chapters[0]!.scores[0]!.void_reason).toBe("call failed: timeout: no reply");
    expect(viewer.calls[1]).toContain("Nothing yet: this is the first chapter.");
  });

  it("flags an odd one out only when two runs agree on it", async () => {
    const run = async (oddPick: string | null, n: number) => runCold(input(fakeViewer({ oddPick }).harness, n));
    const runs = [await run("Label", 1), await run("label", 2), await run("weigh", 3)];

    expect(runs[0]!.chapters[0]!.odd_one_out[0]!.picked).toBe("label");
    expect(agreedOddOnes(runs)).toEqual([{ beat: "c1-1", item: "label" }]);
    expect(agreedOddOnes(runs.slice(1))).toEqual([]);
  });

  // Mutation: grading a bare list item from the viewer's answer lets one judge reading flip the chapter (E9 ch2).
  it("scores a roll call's bare items 0 both when the viewer credits the list's heading and when it does not", async () => {
    const rollCall = buildPaceBeats([
      source("r1-1", "ch1", "Four chores come first: sweep, mop and dust. Then polish.", ["job:sweep", "job:mop", "job:dust", "job:polish"], 6),
    ]);
    const run = async (options: ViewerOptions) => (await runCold({ ...input(fakeViewer(options).harness), beats: rollCall })).chapters[0]!;

    const credited = await run({ why: "none" });
    const declined = await run({ notStated: true });

    for (const chapter of [credited, declined]) {
      expect(chapter.scores.map((s) => [s.item, s.score, s.void_reason])).toEqual(
        ["sweep", "mop", "dust", "polish"].map((item) => [item, 0, "named only in a list"]),
      );
    }
    expect(credited.undefined_per_minute).toBe(declined.undefined_per_minute);
  });

  // Mutation: voiding every bare item, not only a roll call's, zeroes items whose glossed siblings explain them.
  it("leaves one bare item among glossed siblings to the viewer's answer", async () => {
    const glossed = buildPaceBeats([
      source("g1-1", "ch1", "The desk scans each barcode, weighs every parcel on the scale, and labels.", ["job:scan", "job:weigh", "job:label"], 6),
    ]);

    const chapter = (await runCold({ ...input(fakeViewer({ why: "none" }).harness), beats: glossed })).chapters[0]!;

    expect(chapter.scores.map((s) => [s.item, s.score])).toEqual([["scan", 1], ["weigh", 1], ["label", 1]]);
  });

  // Mutation: asking only the item track never asks a term the viewer only hears (E9: head, grant, token, rung).
  it("asks each glossary term and spoken identifier once, where first spoken, unless a new item's label names it", () => {
    const docks = buildPaceBeats([
      source("d1-1", "ch1", "Each parcel waits at the dock until Z9 clears it.", ["card:parcel", "detail:Z9 sign-off"], 6),
      source("d1-2", "ch1", "The dock sends cleared parcels to the van.", [], 6),
      source("d2-1", "ch2", "The van leaves the dock at noon, and the manifest goes with it.", ["card:manifest"], 6),
    ]);

    const asked = coldQuestions(docks, ["dock", "manifest", "van"]).filter((q) => q.kind === "spoken-term");

    expect(asked).toMatchObject([
      { beat: "d1-1", item: "dock", text: 'What is "dock", and why is it there?' },
      { beat: "d1-1", item: "Z9" },
      { beat: "d1-2", item: "van" },
    ]);
  });

  it("poses spoken terms in their chapter and counts an unexplained one as an undefined item", async () => {
    const beats = buildPaceBeats([
      source("d1-1", "ch1", "Each parcel waits at the dock overnight.", ["card:parcel"], 6),
      source("d2-1", "ch2", "The dock opens at noon.", ["card:noon"], 6),
    ]);
    const viewer = fakeViewer({ notStated: true });

    const result = await runCold({ ...input(viewer.harness), beats, glossary: ["dock"] });

    expect(viewer.calls[0]).toContain('"dock"');
    expect(viewer.calls[1]).not.toContain('"dock"');
    expect(result.chapters[0]!.scores.map((s) => [s.kind, s.item, s.score])).toEqual([["what-why", "parcel", 0], ["spoken-term", "dock", 0]]);
    expect(result.chapters[0]!.undefined_items).toBe(2);
  });

  // Mutation: leaving the judge identity out of eval_version mixes two judges' rows.
  it("versions the eval by rubric and judge", () => {
    expect(coldEvalVersion({ rubric, judge: sonnet })).not.toBe(coldEvalVersion({ rubric, judge: { ...sonnet, model: "opus" } }));
    expect(coldEvalVersion({ rubric, judge: sonnet })).not.toBe(coldEvalVersion({ rubric: `${rubric}.`, judge: sonnet }));
  });
});

/** A terms viewer whose nth call names `lists[n]`. */
function termsViewer(lists: readonly string[][]) {
  const calls: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    return { ok: true, output: schema.parse({ terms: lists[calls.length - 1] ?? [] }), usd: 0.03, tokensIn: 500, tokensOut: 20 };
  };
  return { harness, calls };
}

const termsRubric = readRubric("l1-cold-terms.md");

describe("the terms cold viewers cannot define", () => {
  const desk = (): PaceBeat[] =>
    buildPaceBeats([
      source("t1-1", "ch1", "Each parcel takes a token, and the desk keeps its head.", ["card:parcel"], 6),
      source("t2-1", "ch2", "Two chips light when the heads agree.", ["card:light"], 6),
    ]);

  // Mutation: a quorum of one keeps "desk", which only one run named.
  it("keeps a term named in two of three runs and drops one named in a single run", () => {
    expect(agreedTerms([["token", "desk"], ["token"], []], desk(), 2)).toEqual(["token"]);
  });

  it("folds case and plurals into one vote and asks the form the narration speaks first", () => {
    expect(termKey(" Policies ")).toBe("policy");
    expect(termKey("Carry Modules")).toBe("carry module");
    expect(termKey("class")).toBe("class");
    expect(agreedTerms([["Heads", "chip"], ["head", "CHIPS"], []], desk(), 2)).toEqual(["head", "chips"]);
  });

  it("counts a term once a run, and drops one the narration never speaks", () => {
    expect(agreedTerms([["token", "Tokens"], [], ["ledger"], ["ledger"]], desk(), 2)).toEqual([]);
  });

  it("asks fresh viewers of the whole video three times and keeps what two agree on", async () => {
    const viewer = termsViewer([["token"], ["Tokens", "desk"], []]);

    const result = await coldTerms({ beats: desk(), rubric: termsRubric, harness: viewer.harness });

    expect(viewer.calls).toHaveLength(3);
    for (const prompt of viewer.calls) expect(prompt).toContain("## Chapter ch1\n\n[t1-1]");
    expect(viewer.calls[0]).toContain("## Chapter ch2\n\n[t2-1]");
    expect(result).toMatchObject({ terms: ["token"], named: [["token"], ["Tokens", "desk"], []], failures: [] });
    expect(result.spend.tokensIn).toBe(1500);
  });

  // E9: v4 declares no glossary, and head, chip, grant, token and rung are plain words, so only a viewer can name them.
  it("questions at least four of v4's six reader-gap groups once viewers name its plain-word jargon", async () => {
    const { beats, glossary } = paceInput(v4FullScript(), "spike", readTiming(v4Durations()));
    const groups = LabelsSchema.parse(v4Labels()).items;
    const jargon = ["head", "chip", "grant", "token", "rung"];
    const viewer = termsViewer([jargon, jargon.map((t) => `${t}s`), ["tick"]]);
    const questioned = (terms: readonly string[]) => {
      const asked = new Set(coldQuestions(beats, [...glossary, ...terms]).flatMap((q) => ("item" in q ? [termKey(q.item)] : [])));
      return groups.filter((g) => g.items.some((i) => asked.has(termKey(i)))).map((g) => g.group);
    };

    const { terms } = await coldTerms({ beats, rubric: termsRubric, harness: viewer.harness });

    expect(questioned([])).toHaveLength(1);
    expect(questioned(terms)).toEqual(["head and chip", "grant and token", "carry", "ch1 nouns"]);
  });
});

describe("reader-gap group scores", () => {
  const gapTrack = (): PaceBeat[] =>
    buildPaceBeats([
      source("g1-1", "ch1", "Three jobs come first: scan, weigh and stamp.", ["job:scan", "job:weigh", "job:stamp"], 6),
      source("g1-2", "ch1", "Each parcel joins a lane at the dock.", ["card:parcel"], 6),
      source("g2-1", "ch2", "Later the lanes merge, and the dock closes.", ["card:merge"], 6),
    ]);
  const groups = [
    { group: "lanes", items: ["lane", "dock"], first_used: ["g1-2"] },
    { group: "the three jobs", items: ["the three jobs"], first_used: ["g1-1"] },
    { group: "never asked", items: ["ledger"], first_used: ["g3-1"] },
  ];
  /** A viewer that explains every question except those whose text names one of `blank`. */
  const scoredRun = async (blank: readonly string[]) => {
    const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
      const first = promptBeats(prompt).at(-1)!;
      const answers = promptQuestions(prompt).map(({ qid, text }) => {
        const none = text.includes('"relay-') || blank.some((b) => text.includes(`"${b}"`));
        const quotes = none ? [] : [{ beat: first.id, quote: quoteOf(first.spoken) }];
        return { qid, not_stated: none, what: none ? "" : "a thing", what_quotes: quotes, why: none ? "" : "a reason", why_quotes: quotes, odd_one_out: null };
      });
      return { ok: true, output: schema.parse({ answers, summary: "" }), usd: 0, tokensIn: 0, tokensOut: 0 };
    };
    return runCold({ ...input(harness), beats: gapTrack(), glossary: ["lane", "dock"] });
  };

  // Mutation: taking the highest score lets the explained lane hide the unexplained dock.
  it("scores a group at the lowest of its items' first questions", async () => {
    const run = await scoredRun(["dock"]);

    expect(readerGapScores(groups, run)[0]).toEqual({ group: "lanes", asked: ["lane", "dock"], score: 0 });
    expect(readerGapScores(groups, await scoredRun([]))[0]!.score).toBe(2);
  });

  // Mutation: matching only by item words leaves a group named for a whole list unscored.
  it("scores a group no question names by its first-use beats, and leaves an unasked one null", async () => {
    const [, jobs, never] = readerGapScores(groups, await scoredRun([]));

    expect(jobs).toEqual({ group: "the three jobs", asked: ["scan", "weigh", "stamp"], score: 0 });
    expect(never).toEqual({ group: "never asked", asked: [], score: null });
  });
});
