import { describe, expect, it } from "vitest";
import { readRubric } from "./eval-evidence.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import {
  agreedFlags,
  CANARY_NAMES,
  gradeAnswer,
  itemQuestions,
  itemRoutes,
  itemsEvalVersion,
  runItems,
  type ItemAnswer,
  type ItemRoutes,
  type ItemsInput,
  type ItemsResult,
} from "./eval-items.js";
import { explainRoutes } from "./lint-gloss.js";
import { seatRoutes } from "./lint-seat.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { buildPaceBeats, type PaceBeat, type PaceSourceBeat } from "./pace-items.js";

const rubric = readRubric("l1-items.md");

const source = (id: string, chapter: string, spoken: string, cues: string[], mapBeside = false): PaceSourceBeat => ({
  id,
  chapter,
  fn: "WHAT",
  spoken,
  plannedS: 8,
  mapBeside,
  cues: cues.map((target) => ({ target })),
  titles: [],
  reveals: [],
  pins: [],
  cards: [],
  terms: [],
});

/** An invented parcel desk: ch1 names four jobs and lists three bins; ch2 states an invariant with no map. */
const track = (): PaceBeat[] =>
  buildPaceBeats([
    source("c1-1", "ch1", "The desk runs scan, weigh, sort and be quick.", ["job:scan", "job:weigh", "job:sort", "job:be quick"]),
    source("c1-2", "ch1", "Parcels wait in three bins before the van.", ["row:small bin", "row:large bin", "row:cold bin"]),
    source("c2-1", "ch2", "Each parcel gets exactly one label.", ["inv:one label per parcel"]),
  ]);

const routes: ItemRoutes = {
  explain: [{ beat: "c1-1", items: ["sort"] }],
  seat: [{ beat: "c2-1", reason: "invariant" }],
  lists: [{ beat: "c1-1", items: ["scan", "weigh", "sort", "be quick"] }],
};

const input = (harness: JudgeHarness, overrides: Partial<ItemsInput> = {}): ItemsInput => ({
  scriptSha: "a".repeat(64),
  beats: track(),
  routes,
  rubric,
  judge: sonnet,
  harness,
  run: 1,
  ...overrides,
});

const promptQuestions = (prompt: string) => [...prompt.matchAll(/^- (q\d+): (.*)$/gm)].map((m) => ({ qid: m[1]!, text: m[2]! }));
const promptBeats = (prompt: string) => new Map([...prompt.matchAll(/^\[([^\]]+)\]\nspoken: (.*)$/gm)].map((m) => [m[1]!, m[2]!]));
const beatOf = (text: string): string => /^(?:In )?([^\s,]+)/.exec(text)![1]!;
const quoteOf = (text: string): string => text.split(" ").slice(0, 3).join(" ");

type Policy = (q: { qid: string; text: string; beat: string; canary: boolean }) => Partial<ItemAnswer>;

/** A careful judge that quotes each asked beat, refuses the canary and passes every real question unless `policy` says otherwise. */
function fakeJudge(policy: Policy = () => ({}), options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    if (options.fail) return { ok: false, reason: "timeout: no reply", usd: 0, tokensIn: 0, tokensOut: 0 };
    const beats = promptBeats(prompt);
    const answers = promptQuestions(prompt).map(({ qid, text }) => {
      const beat = beatOf(text);
      const canary = !beat.startsWith("c");
      const base = { qid, pass: !canary, odd_one_out: null, evidence: [{ beat, quote: quoteOf(beats.get(beat)!) }] };
      return { ...base, ...policy({ qid, text, beat, canary }) };
    });
    return { ok: true, output: schema.parse({ answers }), usd: 0.01, tokensIn: 200, tokensOut: 40 };
  };
  return { harness, calls };
}

describe("item judge questions", () => {
  it("reads every question off a route, with none for unrouted beats or items", () => {
    const questions = itemQuestions(routes);

    expect(questions.map((q) => [q.kind, q.beat, q.subject])).toEqual([
      ["explained", "c1-1", "sort"],
      ["seated", "c2-1", "invariant"],
      ["odd-one-out", "c1-1", "scan; weigh; sort; be quick"],
    ]);
  });

  it("builds its routes from the L0 explain and seat route lists and the list beats", () => {
    const beats = track();

    const built = itemRoutes(beats, []);

    expect(built.explain).toEqual(explainRoutes(beats));
    expect(built.seat).toEqual(seatRoutes(beats, []));
    expect(built.lists.map((l) => l.beat)).toEqual(["c1-1", "c1-2"]);
  });

  it("asks the model only the routed questions plus the canary, so an unrouted list beat goes unasked", async () => {
    const judge = fakeJudge();

    await runItems(input(judge.harness));

    const asked = judge.calls.flatMap(promptQuestions).map((q) => q.text);
    expect(asked.filter((t) => t.includes("c1-2"))).toEqual([]);
    expect(asked).toHaveLength(itemQuestions(routes).length + 2);
  });
});

describe("runItems", () => {
  it("makes one fresh call per chapter with a routed question, each with a name-only canary beat planted last", async () => {
    const judge = fakeJudge();

    const result = await runItems(input(judge.harness));

    expect(judge.calls).toHaveLength(2);
    const lastBeats = judge.calls.map((prompt) => [...promptBeats(prompt).values()].at(-1)!);
    for (const name of CANARY_NAMES) expect(lastBeats.every((spoken) => spoken.includes(name))).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.chapters.flatMap((c) => c.verdicts).map((v) => v.pass)).toEqual([true, true, true]);
  });

  it("skips a chapter no route reaches", async () => {
    const judge = fakeJudge();

    const result = await runItems(input(judge.harness, { routes: { explain: [], seat: [], lists: [routes.lists[0]!] } }));

    expect(judge.calls).toHaveLength(1);
    expect(result.chapters.map((c) => c.chapter)).toEqual(["ch1"]);
  });

  it("voids a verdict whose quote paraphrases the beat instead of copying it", async () => {
    const judge = fakeJudge((q) => (q.canary ? {} : { evidence: [{ beat: q.beat, quote: "the desk sorts parcels" }] }));

    const result = await runItems(input(judge.harness));

    const verdicts = result.chapters.flatMap((c) => c.verdicts);
    expect(verdicts.every((v) => v.pass === null)).toBe(true);
    expect(verdicts[0]!.void_reason).toBe("quote not found in c1-1");
  });

  it("marks the run untrusted when the judge calls the canary's name explained", async () => {
    const judge = fakeJudge((q) => (q.canary ? { pass: true, evidence: [{ beat: q.beat, quote: "Three more parts" }] } : {}));

    const result = await runItems(input(judge.harness));

    expect(result.trusted).toBe(false);
    expect(result.chapters.map((c) => c.canary.got)).toEqual(["explained", "explained"]);
  });

  it("marks the run untrusted when the canary refusal cites nothing it can find", async () => {
    const judge = fakeJudge((q) => (q.canary ? { evidence: [{ beat: q.beat, quote: "names three parts" }] } : {}));

    const result = await runItems(input(judge.harness));

    expect(result.trusted).toBe(false);
    expect(result.chapters[0]!.canary).toMatchObject({ got: "void", pass: false });
  });

  it("voids every verdict and distrusts the run when a call fails", async () => {
    const result = await runItems(input(fakeJudge(undefined, { fail: true }).harness));

    expect(result.trusted).toBe(false);
    expect(result.failures).toEqual(["timeout: no reply", "timeout: no reply"]);
    expect(result.chapters[0]!.verdicts[0]!.void_reason).toBe("call failed: timeout: no reply");
  });

  it("places the canary question by nonce, so runs differ in where it sits", async () => {
    const slots = [];
    for (let run = 1; run <= 6; run++) {
      const judge = fakeJudge();
      await runItems(input(judge.harness, { run }));
      slots.push(promptQuestions(judge.calls[0]!).findIndex((q) => !beatOf(q.text).startsWith("c")));
    }

    expect(new Set(slots).size).toBeGreaterThan(1);
  });
});

describe("gradeAnswer", () => {
  const beats = track();
  const texts = {
    spoken: new Map(beats.map((b) => [b.id, `spoken: ${b.spoken}`])),
    shown: new Map(beats.map((b) => [b.id, `spoken: ${b.spoken}\non screen: ${b.items.map((i) => i.label).join("; ")}`])),
  };
  const [explained, , oddOneOut] = itemQuestions(routes);

  it("voids an 'explained' yes that cites only an on-screen label", () => {
    const answer = { qid: "q1", pass: true, odd_one_out: null, evidence: [{ beat: "c1-1", quote: "sort; be quick" }] };

    expect(gradeAnswer("q1", explained!, answer, texts)).toMatchObject({ pass: null, void_reason: "quote not found in c1-1" });
  });

  it("accepts a 'not explained' verdict that quotes where the item is named on screen", () => {
    const answer = { qid: "q1", pass: false, odd_one_out: null, evidence: [{ beat: "c1-1", quote: "sort; be quick" }] };

    expect(gradeAnswer("q1", explained!, answer, texts)).toMatchObject({ pass: false, void_reason: null });
  });

  it("matches an odd-one-out pick to its listed label regardless of case", () => {
    const answer = { qid: "q3", pass: false, odd_one_out: "Be Quick", evidence: [{ beat: "c1-1", quote: "The desk runs" }] };

    expect(gradeAnswer("q3", oddOneOut!, answer, texts)).toMatchObject({ pass: false, picked: "be quick" });
  });

  it("voids an odd-one-out pick the beat does not list", () => {
    const answer = { qid: "q3", pass: false, odd_one_out: "deliver", evidence: [{ beat: "c1-1", quote: "The desk runs" }] };

    expect(gradeAnswer("q3", oddOneOut!, answer, texts)).toMatchObject({ pass: null, picked: null, void_reason: 'picks "deliver", which c1-1 does not list' });
  });
});

describe("agreedFlags", () => {
  const runWith = (pickedQuick: boolean): ItemsResult => ({
    eval_version: "v",
    judge: "claude-print:sonnet",
    failures: [],
    trusted: true,
    spend: { usd: 0, tokensIn: 0, tokensOut: 0 },
    chapters: [
      {
        chapter: "ch1",
        canary: { canary: "x:brindle", dim: "explained", got: "not_explained", pass: true },
        verdicts: [
          { qid: "q1", kind: "explained", beat: "c1-1", subject: "sort", pass: false, picked: null, evidence: "", void_reason: null },
          { qid: "q2", kind: "odd-one-out", beat: "c1-1", subject: "", pass: !pickedQuick, picked: pickedQuick ? "be quick" : null, evidence: "", void_reason: null },
        ],
      },
    ],
  });

  it("keeps a flag two of three runs agree on and drops one run's pick", () => {
    expect(agreedFlags([runWith(true), runWith(false), runWith(false)])).toEqual([{ kind: "explained", beat: "c1-1", item: "sort" }]);
    expect(agreedFlags([runWith(true), runWith(true), runWith(false)])).toContainEqual({ kind: "odd-one-out", beat: "c1-1", item: "be quick" });
  });
});

describe("itemsEvalVersion", () => {
  it("changes with the rubric and the judge, and is its own eval id", () => {
    const base = itemsEvalVersion({ rubric, judge: sonnet });

    expect(itemsEvalVersion({ rubric: `${rubric}\nOne more rule.`, judge: sonnet })).not.toBe(base);
    expect(itemsEvalVersion({ rubric, judge: { ...sonnet, model: "opus" } })).not.toBe(base);
  });
});
