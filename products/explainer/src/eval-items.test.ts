import { describe, expect, it } from "vitest";
import { readRubric } from "./eval-evidence.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import {
  agreedFlags,
  CANARY_NAMES,
  gradeItemAnswer,
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
import { parseSpine } from "./spine-schema.js";

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

describe("item judge questions by beat role", () => {
  /** ch1 promises three moves and names three skipped details; ch2 lists three bare jobs. Each beat routes on M3. */
  const roleTrack = (): PaceBeat[] =>
    buildPaceBeats([
      { ...source("c1-1", "ch1", "The desk keeps, drops and adds bins.", ["card:keeps", "card:drops", "card:adds"]), fn: "PROMISE" },
      { ...source("c1-2", "ch1", "Customs holds, returns and refunds are left out; each is data, so the flow holds.", ["open:customs holds", "open:returns", "open:refunds"]), fn: "CAVEAT" },
      source("c2-1", "ch2", "Three jobs: scan, weigh and stack.", ["job:scan", "job:weigh", "job:stack"]),
    ]);
  const explainedOnly = (beats: PaceBeat[]): ItemRoutes => ({ ...itemRoutes(beats, []), seat: [], lists: [] });
  /** The E9 judge: no beat in these chapters says what and why, so every plain "explained" is a no. */
  const literalJudge = () => fakeJudge((q) => (q.canary ? {} : { pass: q.text.includes("left out on purpose") }));

  it("routes all three beats on M3, so only the role decides what is asked", () => {
    expect(explainRoutes(roleTrack()).map((r) => r.beat)).toEqual(["c1-1", "c1-2", "c2-1"]);
  });

  // Mutation: asking a PROMISE beat the plain question flags keeps, drops and adds.
  it("never asks a promise beat whether its items are explained", async () => {
    const judge = literalJudge();
    const beats = roleTrack();

    const result = await runItems(input(judge.harness, { beats, routes: explainedOnly(beats) }));

    const asked = judge.calls.flatMap(promptQuestions).map((q) => beatOf(q.text));
    expect(asked).not.toContain("c1-1");
    expect(agreedFlags([result, result]).filter((f) => f.beat === "c1-1")).toEqual([]);
  });

  // Mutation: asking a CAVEAT beat the plain question flags all three skipped details.
  it("asks a simplification beat why the picture holds without each item, which it can pass", async () => {
    const judge = literalJudge();
    const beats = roleTrack();

    const result = await runItems(input(judge.harness, { beats, routes: explainedOnly(beats) }));

    const verdicts = result.chapters.flatMap((c) => c.verdicts);
    expect(verdicts.filter((v) => v.beat === "c1-2").map((v) => [v.kind, v.subject, v.pass])).toEqual([
      ["explained", "customs holds", true],
      ["explained", "returns", true],
      ["explained", "refunds", true],
    ]);
    expect(agreedFlags([result, result]).map((f) => [f.beat, f.item])).toEqual([["c2-1", "scan"], ["c2-1", "weigh"], ["c2-1", "stack"]]);
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
    expect(result.chapters.map((c) => c.canary?.got)).toEqual(["explained", "explained"]);
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

describe("gradeItemAnswer", () => {
  const beats = track();
  const texts = {
    spoken: new Map(beats.map((b) => [b.id, `spoken: ${b.spoken}`])),
    shown: new Map(beats.map((b) => [b.id, `spoken: ${b.spoken}\non screen: ${b.items.map((i) => i.label).join("; ")}`])),
  };
  const [explained, , oddOneOut] = itemQuestions(routes);

  it("voids an 'explained' yes that cites only an on-screen label", () => {
    const answer = { qid: "q1", pass: true, odd_one_out: null, evidence: [{ beat: "c1-1", quote: "sort; be quick" }] };

    expect(gradeItemAnswer("q1", explained!, answer, texts)).toMatchObject({ pass: null, void_reason: "quote not found in c1-1" });
  });

  it("accepts a 'not explained' verdict that quotes where the item is named on screen", () => {
    const answer = { qid: "q1", pass: false, odd_one_out: null, evidence: [{ beat: "c1-1", quote: "sort; be quick" }] };

    expect(gradeItemAnswer("q1", explained!, answer, texts)).toMatchObject({ pass: false, void_reason: null });
  });

  it("matches an odd-one-out pick to its listed label regardless of case", () => {
    const answer = { qid: "q3", pass: false, odd_one_out: "Be Quick", evidence: [{ beat: "c1-1", quote: "The desk runs" }] };

    expect(gradeItemAnswer("q3", oddOneOut!, answer, texts)).toMatchObject({ pass: false, picked: "be quick" });
  });

  it("voids an odd-one-out pick the beat does not list", () => {
    const answer = { qid: "q3", pass: false, odd_one_out: "deliver", evidence: [{ beat: "c1-1", quote: "The desk runs" }] };

    expect(gradeItemAnswer("q3", oddOneOut!, answer, texts)).toMatchObject({ pass: null, picked: null, void_reason: 'picks "deliver", which c1-1 does not list' });
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

/** An invented parcel desk spine: §3 names invariant I1, §4's one part keeps the invariant `keptBy` names. */
const spineDoc = (ledger: string, keptBy = "I1") => `# Story spine: parcel-desk-synthetic

## 3. Journey
| # | Step | What | Why | Invariant | Today |
|---|---|---|---|---|---|
| 1 | Scan | the scanner reads the barcode | no barcode, no record | I1 one label per parcel | — |

## 4. Architecture
| Part | Carries | Mechanism | Constraint |
|---|---|---|---|
| Label printer | 1 | prints once per barcode (${keptBy}) | — |

## 5. Constraints
| Constraint | Forces |
|---|---|

## 6. Item ledger
| Item | Kind | Defined in | Reused in |
|---|---|---|---|
${ledger}
`;

const ledgerRows = (kinds: Record<string, string>) =>
  Object.entries(kinds)
    .map(([item, kind]) => `| ${item} | ${kind} | c1-1 | — |`)
    .join("\n");

const DESK_LEDGER = { scan: "step", weigh: "step", sort: "step", "be legible": "step" };

const spineTrack = (): PaceBeat[] =>
  buildPaceBeats([
    source("c1-1", "ch1", "The desk runs scan, weigh, sort and be legible.", ["job:scan", "job:weigh", "job:sort", "job:be legible"]),
    source("c2-1", "ch2", "Each parcel gets exactly one label.", ["inv:I1 one label per parcel"], true),
  ]);

/** What each listed item really is; the fake flags an item only when the declared kind in the question disagrees. */
const TRUE_KINDS: Record<string, string> = { scan: "step", weigh: "step", sort: "step", "be legible": "property" };

const misdeclared = (text: string): string | null => {
  const declared = [...text.matchAll(/"([^"]+)" an? (\w+)/g)].map((m) => ({ label: m[1]!, kind: m[2]! }));
  return declared.find((d) => TRUE_KINDS[d.label] !== d.kind)?.label ?? null;
};

const kindJudge = () => fakeJudge((q) => (q.text.includes("spine ledger declares") ? { odd_one_out: misdeclared(q.text) } : {}));

const spineInput = (harness: JudgeHarness, spineMd: string, overrides: Partial<ItemsInput> = {}): ItemsInput => {
  const beats = spineTrack();
  return input(harness, { beats, routes: itemRoutes(beats, []), spine: parseSpine(spineMd), ...overrides });
};

const verdictsOf = (result: ItemsResult) => result.chapters.flatMap((c) => c.verdicts);

describe("runItems with a story spine", () => {
  it("flags a list item the ledger declares a step that is not one", async () => {
    const runs = [];
    for (let run = 1; run <= 2; run++) runs.push(await runItems(spineInput(kindJudge().harness, spineDoc(ledgerRows(DESK_LEDGER)), { run })));

    expect(verdictsOf(runs[0]!).find((v) => v.kind === "kind-honest")).toMatchObject({ beat: "c1-1", pass: false, picked: "be legible" });
    expect(agreedFlags(runs)).toContainEqual({ kind: "kind-honest", beat: "c1-1", item: "be legible" });
  });

  it("asks about the declared kinds in place of the blind odd one out, and passes a ledger that declares them truly", async () => {
    const judge = kindJudge();

    const result = await runItems(spineInput(judge.harness, spineDoc(ledgerRows({ ...DESK_LEDGER, "be legible": "property" }))));

    const asked = judge.calls.flatMap(promptQuestions).map((q) => q.text);
    expect(asked.some((t) => t.includes('"be legible" a property'))).toBe(true);
    expect(verdictsOf(result).map((v) => v.kind)).not.toContain("odd-one-out");
    expect(verdictsOf(result).find((v) => v.kind === "kind-honest")).toMatchObject({ pass: true, picked: null });
  });

  it("keeps the blind odd one out for a list beat with an item the ledger does not list", async () => {
    const partial = Object.fromEntries(Object.entries(DESK_LEDGER).filter(([item]) => item !== "be legible"));

    const result = await runItems(spineInput(kindJudge().harness, spineDoc(ledgerRows(partial))));

    expect(verdictsOf(result).map((v) => v.kind)).toContain("odd-one-out");
    expect(verdictsOf(result).map((v) => v.kind)).not.toContain("kind-honest");
  });

  it("fails an invariant seat no §4 part keeps without a model call", async () => {
    const judge = kindJudge();
    const routes: ItemRoutes = { explain: [], seat: [{ beat: "c2-1", reason: "invariant" }], lists: [] };

    const result = await runItems(spineInput(judge.harness, spineDoc(ledgerRows(DESK_LEDGER), "I2"), { routes }));

    expect(judge.calls).toEqual([]);
    expect(result.chapters).toEqual([
      { chapter: "ch2", canary: null, verdicts: [expect.objectContaining({ kind: "seated", beat: "c2-1", pass: false, evidence: 'spine: no §4 part keeps "I1 one label per parcel"' })] },
    ]);
    expect(agreedFlags([result, result])).toEqual([{ kind: "seated", beat: "c2-1", item: "invariant" }]);
  });

  it("fails an invariant seat that states no §3 invariant without a model call", async () => {
    const judge = kindJudge();
    const beats = buildPaceBeats([source("c2-1", "ch2", "Labels never repeat.", ["inv:I9 labels never repeat"], true)]);
    const routes: ItemRoutes = { explain: [], seat: [{ beat: "c2-1", reason: "invariant" }], lists: [] };

    const result = await runItems(spineInput(judge.harness, spineDoc(ledgerRows(DESK_LEDGER)), { beats, routes }));

    expect(judge.calls).toEqual([]);
    expect(verdictsOf(result)[0]).toMatchObject({ pass: false, evidence: "spine: no §3 invariant matches what this beat states" });
  });

  it("poses an invariant seat the spine pairs with a part, naming that part", async () => {
    const judge = kindJudge();
    const routes: ItemRoutes = { explain: [], seat: [{ beat: "c2-1", reason: "invariant" }], lists: [] };

    const result = await runItems(spineInput(judge.harness, spineDoc(ledgerRows(DESK_LEDGER)), { routes }));

    expect(judge.calls.flatMap(promptQuestions).map((q) => q.text)).toContainEqual(expect.stringContaining('the spine says "Label printer" keeps'));
    expect(result.trusted).toBe(true);
    expect(verdictsOf(result)).toEqual([expect.objectContaining({ kind: "seated", beat: "c2-1", pass: true })]);
  });

  it("versions spine runs apart and leaves the no-spine version as it was", () => {
    const spine = parseSpine(spineDoc(ledgerRows(DESK_LEDGER)));

    expect(itemsEvalVersion({ rubric, judge: sonnet, spine })).not.toBe(itemsEvalVersion({ rubric, judge: sonnet }));
    expect(itemsEvalVersion({ rubric, judge: sonnet, spine: undefined })).toBe(itemsEvalVersion({ rubric, judge: sonnet }));
  });
});
