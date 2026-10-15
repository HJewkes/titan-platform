import { describe, expect, it } from "vitest";
import {
  agreedOddOnes,
  coldEvalVersion,
  coldQuestions,
  playbackTranscript,
  runCold,
  type ColdInput,
} from "./eval-cold.js";
import { readRubric } from "./eval-evidence.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { buildPaceBeats, type PaceBeat, type PaceSourceBeat } from "./pace-items.js";

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
        what_quotes: blank ? [] : [{ beat: first.id, quote: quoteOf(first.spoken) }],
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

describe("the playback transcript", () => {
  it("shows each label at its exposure second and each beat's end on the chapter's clock", () => {
    const [a, b] = track();
    const timed: PaceBeat = { ...b!, durationS: 4.5, items: [{ ...b!.items[0]!, atS: 2.8 }] };

    const text = playbackTranscript([{ ...a!, durationS: 4 }, timed]);

    expect(text).toContain("[c1-2] from 4.0 s\nspoken: Each parcel gets exactly one label");
    expect(text).toContain("on screen: `one label per parcel` from 6.8 s\nbeat ends at 8.5 s");
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

    expect(invented).toMatchObject({ score: 0, void_reason: "quote not found in c1-1" });
    expect(misplaced).toMatchObject({ score: 0, void_reason: "cites unknown beat c1-1" });
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

  // Mutation: leaving the judge identity out of eval_version mixes two judges' rows.
  it("versions the eval by rubric and judge", () => {
    expect(coldEvalVersion({ rubric, judge: sonnet })).not.toBe(coldEvalVersion({ rubric, judge: { ...sonnet, model: "opus" } }));
    expect(coldEvalVersion({ rubric, judge: sonnet })).not.toBe(coldEvalVersion({ rubric: `${rubric}.`, judge: sonnet }));
  });
});
