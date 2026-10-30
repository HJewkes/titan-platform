import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgreementRecordSchema } from "./calibration-agreement.js";
import { QueueKeySchema, type QueueKey } from "./calibration-queue.js";
import { runEvalCli } from "./eval-cli.js";
import { appendTsv, scriptSha } from "./eval-store.js";
import { auditionEntry } from "./calibration-fakes.test-helpers.js";
import { tour } from "./voice-flow-fixtures.test-helpers.js";

let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const SCORE = ["config_id", "eval_version", "run", "script_sha", "chapter", "kind", "beat", "item", "dim", "score", "void_reason"] as const;
type Score = Partial<Record<(typeof SCORE)[number], string>>;
const SCRIPT = tour();
const BEATS = SCRIPT.beats.slice(0, 6);

const VERSION_OF: Record<string, string> = { "cold-scores.tsv": "ev-cold", "cold-rubric-scores.tsv": "ev-rubric", "beat-scores.tsv": "ev-l1" };

const tsv = (bench: string, file: string, rows: Score[]): void =>
  appendTsv(join(bench, "evals", file), SCORE, rows.map((r) => ({ void_reason: "", eval_version: VERSION_OF[file], ...r })));

const CODE_ZEROS = { "bare-item": "named only in a list", "skipped-item": "not answered", "failed-item": "call failed: timeout" };

/**
 * A synthetic bench: one judged script with cold, rubric and l1 rows that alternate pass and fail. Cold runs three
 * viewers, the rubric was judged by an older config before the current one, and code wrote some cold zeros.
 */
function bench(name: string): { script: string; bench: string } {
  const script = join(dir, `${name}.json`);
  writeFileSync(script, JSON.stringify(SCRIPT));
  const sha = scriptSha(SCRIPT);
  const root = join(dir, `bench-${name}`);
  const cold = (run: string) => BEATS.map((beat, i) => ({ run, script_sha: sha, chapter: beat.chapter, kind: "what-why", beat: beat.id, item: `item-${i}`, score: String(i % 3), void_reason: i % 3 === 0 ? "not stated" : "" }));
  tsv(root, "cold-scores.tsv", ["1", "2", "3"].flatMap(cold));
  tsv(root, "cold-scores.tsv", [{ run: "3", script_sha: sha, chapter: BEATS[1]!.chapter, kind: "invariant", beat: BEATS[1]!.id, item: "item-1", score: "0", void_reason: "not stated" }]);
  tsv(root, "cold-scores.tsv", Object.entries(CODE_ZEROS).map(([item, reason]) => ({ script_sha: sha, chapter: BEATS[0]!.chapter, kind: "what-why", beat: BEATS[0]!.id, item, score: "0", void_reason: reason })));
  const rubric = (config: string) => ["J8", "J9", "J10", "J11", "J12"].map((dim, i) => ({ config_id: config, run: "1", script_sha: sha, dim, score: String(i + 1) }));
  tsv(root, "cold-rubric-scores.tsv", [...rubric("cfg-old"), ...rubric("cfg-new")]);
  tsv(root, "beat-scores.tsv", BEATS.flatMap((beat, i) => ["B1", "B3"].map((dim) => ({ script_sha: sha, beat: beat.id, dim, score: String(i % 2) }))));
  tsv(root, "beat-scores.tsv", [{ script_sha: "another", beat: BEATS[0]!.id, dim: "B1", score: "1" }, { script_sha: sha, beat: BEATS[1]!.id, dim: "B2", score: "", void_reason: "no quote" }]);
  return { script, bench: root };
}

/** A listener result over the bench script's chapters; `dense` chapters get 3 questions a sentence, the rest 1, unless `at` says. */
function listener(name: string, density: number, dense: readonly string[] = [], at: Record<string, number> = {}): string {
  const chapters = [...new Set(BEATS.map((b) => b.chapter))].map((chapter) => ({
    chapter, sentences: [], questions: 0, density: at[chapter] ?? (dense.includes(chapter) ? 3 : 1), untagged: 0, asked: [],
    flags: { list_spread: [], terms_before_setup: [], fragments: [] }, failure: null,
  }));
  const path = join(dir, `listener-${name}.json`);
  writeFileSync(path, JSON.stringify({ eval_version: "ev-listener", judge: "fake", chapters, questions: 0, sentences: 0, density, failures: [], spend: { usd: 0, tokensIn: 0, tokensOut: 0 } }));
  return path;
}

type Listeners = Partial<Record<"tour" | "held" | "digest", string>>;

function manifest(extra: Record<string, unknown> = {}, listeners: Listeners = {}): string {
  const entry = (name: keyof Listeners, split: string, videoType: string) => ({
    case: `explainer-eval/${name}`, title: `Video ${name}`, video_type: videoType, split, owner_named: false, ...bench(name),
    ...(listeners[name] ? { listener: listeners[name] } : {}),
  });
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ schema: "calibration-manifest/v1", cases: [entry("tour", "dev", "repo-tour"), entry("held", "holdout", "repo-tour"), entry("digest", "dev", "status")], ...extra }));
  return path;
}

const printed = (): string => log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const readKey = (): QueueKey => QueueKeySchema.parse(readJson(join(dir, "key.json")));
const RoundSchema = z.looseObject({ questions: z.array(z.looseObject({})), sections: z.array(z.looseObject({ title: z.string() })) });

beforeEach(() => {
  VERSION_OF["cold-scores.tsv"] = "ev-cold";
  dir = mkdtempSync(join(tmpdir(), "explainer-calibrate-judges-"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const queue = (...extra: string[]) => queueFrom(manifest(), ...extra);
const queueFrom = (path: string, ...extra: string[]) =>
  runEvalCli(["eval", "calibrate", "queue", path, "--round-dir", join(dir, "round"), "--key", join(dir, "key.json"), "--unit", "judge-cal", ...extra]);

describe("explainer eval calibrate queue", () => {
  it("writes a blind round of 20 items mixed across judges and video types, with the holdout left out", async () => {
    const code = await queue();

    expect(error.mock.calls).toEqual([]);
    expect(code).toBe(0);
    const round = RoundSchema.parse(readJson(join(dir, "round", "round.json")));
    const key = readKey();
    expect(round).toMatchObject({ schema: "titan-review/round@2", unit: "judge-cal", variants: [] });
    expect(round.questions).toHaveLength(20);
    expect(round.sections.map((s) => s.title)).toEqual(["Video digest", "Video tour"]);
    expect(new Set(key.entries.map((e) => e.judge))).toEqual(new Set(["cold", "cold-rubric", "l1"]));
    expect(new Set(key.entries.filter((e) => e.judge === "cold").map((e) => e.pass))).toEqual(new Set([true, false]));
    expect(key.entries.some((e) => e.case.endsWith("held"))).toBe(false);
    expect(round.questions.filter((q) => "recommendation" in q)).toEqual([]);
    expect(JSON.stringify(round)).not.toMatch(/cold-rubric|"judge"|"pass"/);
    expect(JSON.parse(printed())).toMatchObject({ items: 20, minutes: 25 });
  });

  it("queues each question once, from the judge's own latest verdict, and names the config and run it came from", async () => {
    expect(await queue("--size", "200")).toBe(0);

    const entries = readKey().entries;
    const targets = entries.map((e) => `${e.case} ${e.judge} ${e.target}`);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.filter((t) => /bare-item|skipped-item|failed-item/.test(t))).toEqual([]);
    expect(entries.some((e) => e.judge === "cold" && e.target.endsWith("item-0") && !e.pass)).toBe(true);
    expect(entries.filter((e) => e.judge === "cold").map((e) => e.run)).toEqual(entries.filter((e) => e.judge === "cold").map(() => "3"));
    expect(new Set(entries.filter((e) => e.judge === "cold-rubric").map((e) => e.configId))).toEqual(new Set(["cfg-new"]));
    expect(new Set(entries.map((e) => `${e.judge} ${e.evalVersion}`))).toEqual(new Set(["cold ev-cold", "cold-rubric ev-rubric", "l1 ev-l1"]));
  });

  it("queues an invariant item's what-why and invariant verdicts as two questions, each in the words the viewer was asked", async () => {
    expect(await queue("--size", "200")).toBe(0);

    const round = z.object({ questions: z.array(z.looseObject({ id: z.string(), prompt: z.string() })) }).parse(readJson(join(dir, "round", "round.json")));
    const prompt = new Map(round.questions.map((q) => [q.id, q.prompt]));
    const asked = readKey().entries.filter((e) => e.case.endsWith("tour") && e.judge === "cold" && e.target.endsWith("item-1"));
    expect(asked.map((e) => [e.target.split(" · ")[1], e.pass]).sort()).toEqual([["invariant", false], ["what-why", true]]);
    expect(asked.map((e) => prompt.get(e.id)!).filter((p) => p.includes("must always hold"))).toHaveLength(1);
    expect(asked.map((e) => prompt.get(e.id)!).filter((p) => p.includes('What is "item-1"'))).toHaveLength(1);
  });

  it("asks each audition's pick against its runner-up once, as A or B, scored for both pickers", async () => {
    const auditions = [auditionEntry(dir, "one", { J8: 4 }, { J8: 2 }), auditionEntry(dir, "two", { J8: 2 }, { J8: 4 })];

    expect(await queueFrom(manifest({ auditions }))).toBe(0);

    const round = z.object({ questions: z.array(z.looseObject({ id: z.string(), options: z.array(z.string()) })) }).parse(readJson(join(dir, "round", "round.json")));
    const pairs = readKey().entries.filter((e) => e.judge.startsWith("audition-"));
    const ids = [...new Set(pairs.map((e) => e.id))];
    expect(ids).toHaveLength(2);
    expect(pairs).toHaveLength(4);
    for (const id of ids) expect(round.questions.find((q) => q.id === id)?.options).toEqual([`A (${id})`, `B (${id})`, `Can't tell (${id})`]);
  });

  it("under --max-density, drops a dense chapter's cold and l1 items and a dense script's rubric items", async () => {
    const listeners = { tour: listener("tour", 2.7, ["ch1"]), held: listener("held", 1), digest: listener("digest", 2.5) };

    expect(await queueFrom(manifest({}, listeners), "--size", "200", "--max-density", "2.5")).toBe(0);

    const entries = readKey().entries;
    const denseBeats = BEATS.filter((b) => b.chapter === "ch1").map((b) => b.id);
    const tour = entries.filter((e) => e.case.endsWith("tour") && e.judge !== "listener");
    expect(tour.filter((e) => denseBeats.includes(e.target.split(" · ")[0]!))).toEqual([]);
    expect(new Set(tour.map((e) => e.judge))).toEqual(new Set(["cold", "l1"]));
    expect(entries.some((e) => e.case.endsWith("digest") && e.judge === "cold-rubric")).toBe(true);
    expect(entries.some((e) => e.case.endsWith("digest") && denseBeats.includes(e.target.split(" · ")[0]!))).toBe(true);
  });

  it("refuses --max-density when a case has no listener result, naming the case", async () => {
    const listeners = { tour: listener("tour", 1), held: listener("held", 1) };

    expect(await queueFrom(manifest({}, listeners), "--max-density", "2.5")).toBe(2);

    expect(String(error.mock.calls[0]?.[0])).toMatch(/explainer-eval\/digest: --max-density needs the case's listener result/);
  });

  it("orders the clearest video first, then the pairs, and writes the round number and minutes per kind of item, in a round the console files", async () => {
    const listeners = { tour: listener("tour", 1), held: listener("held", 1), digest: listener("digest", 2) };
    const auditions = [auditionEntry(dir, "one", { J8: 4 }, { J8: 2 }), auditionEntry(dir, "two", { J8: 2 }, { J8: 4 })];

    expect(await queueFrom(manifest({ auditions }, listeners), "--max-density", "2.5", "--round", "2")).toBe(0);

    const round = z.looseObject({ round: z.number(), variants: z.array(z.unknown()), sections: z.array(z.object({ title: z.string() }).loose()), questions: z.array(z.looseObject({})) })
      .parse(readJson(join(dir, "round", "round.json")));
    expect(round.sections.map((s) => s.title)).toEqual(["Video tour", "Storyboard pairs", "Video digest"]);
    expect(round.round).toBe(2);
    expect(JSON.parse(printed())).toMatchObject({ items: 23, minutes: Math.round(21 * 1.25 + 2 * 2) });
    expect(readFileSync(join(dir, "round", "round.json")).length).toBeLessThan(1024 * 1024);
    expect(round.variants).toEqual([]);
    expect(round.questions.filter((q) => "merge" in q)).toEqual([]);
  });

  it("adds 3 \"clear on one hearing?\" items to the 20 under --max-density, for the chapters nearest the bar either side of it", async () => {
    const listeners = { tour: listener("tour", 2, [], { ch1: 2.4, ch2: 1 }), held: listener("held", 2.5, [], { ch1: 2.5 }), digest: listener("digest", 2.5, [], { ch1: 2.7, ch2: 4 }) };

    expect(await queueFrom(manifest({}, listeners), "--max-density", "2.5")).toBe(0);

    const round = z.object({ questions: z.array(z.looseObject({ id: z.string(), prompt: z.string(), options: z.array(z.string()) })) }).parse(readJson(join(dir, "round", "round.json")));
    const heard = readKey().entries.filter((e) => e.judge === "listener");
    expect(round.questions).toHaveLength(23);
    expect(heard.map((e) => `${e.case.split("/")[1]} ${e.target} ${e.density}`).sort()).toEqual(["digest ch1 2.7", "tour ch1 2.4", "tour ch2 1"]);
    for (const e of heard) {
      const asked = round.questions.find((q) => q.id === e.id)!;
      expect(asked.prompt).toMatch(/^Is this chapter clear enough to follow on one hearing\?\n\n\[ch\d\] /);
      expect(asked.options).toEqual([`Yes (${e.id})`, `No (${e.id})`, `Can't tell (${e.id})`]);
    }
    expect(JSON.stringify(round)).not.toMatch(/density|2\.7|2\.4/);
  });

  it("returns a submitted round's listener answers as a yes or no per chapter beside its listener density", async () => {
    const listeners = { tour: listener("tour", 2, [], { ch1: 2.4, ch2: 1 }), held: listener("held", 1), digest: listener("digest", 2.5, [], { ch1: 2.7, ch2: 4 }) };
    expect(await queueFrom(manifest({}, listeners), "--max-density", "2.5")).toBe(0);
    answer(join(dir, "feedback.json"), (judge) => judge === "listener");
    log.mockClear();

    const args = ["--key", join(dir, "key.json"), "--feedback", join(dir, "feedback.json"), "--out", join(dir, "listener-labels.json")];
    expect(await runEvalCli(["eval", "calibrate", "listener-labels", ...args])).toBe(0);

    const record = z.object({ schema: z.literal("listener-labels/v1"), round: z.string(), rows: z.array(z.looseObject({})) }).parse(readJson(join(dir, "listener-labels.json")));
    expect(record.round).toBe("judge-cal-r1");
    expect(record.rows).toEqual(expect.arrayContaining([
      { case: "explainer-eval/tour", chapter: "ch1", density: 2.4, clear: false, eval_version: "ev-listener" },
      { case: "explainer-eval/tour", chapter: "ch2", density: 1, clear: false, eval_version: "ev-listener" },
      { case: "explainer-eval/digest", chapter: "ch1", density: 2.7, clear: true, eval_version: "ev-listener" },
    ]));
    expect(record.rows).toHaveLength(3);
    expect(JSON.parse(printed())).toEqual(record);
  });

  it("refuses to overwrite a round that is already published", async () => {
    expect(await queue()).toBe(0);
    expect(await queue()).toBe(2);
  });
});

/** Labels every question of the key just written: the judge's own verdict, or its opposite when `disagree` says so. */
function answer(feedback: string, disagree: (judge: string) => boolean = () => false): void {
  const answers = readKey().entries.map((e) => ({ questionId: e.id, pick: `${e.pass !== disagree(e.judge) ? "Yes" : "No"} (${e.id})` }));
  writeFileSync(feedback, JSON.stringify({ schema: "titan-review/feedback@1", answers }));
}

describe("explainer eval calibrate agreement", () => {
  it("reports agreement per judge from the round's feedback and records it, still refusing promotion below the bar", async () => {
    expect(await queue()).toBe(0);
    const answers = readKey().entries.map((e, i) => ({
      questionId: e.id, pick: `${e.judge === "l1" || i % 2 === 0 ? (e.pass ? "Yes" : "No") : e.pass ? "No" : "Yes"} (${e.id})`,
    }));
    writeFileSync(join(dir, "round", "feedback.json"), JSON.stringify({ schema: "titan-review/feedback@1", answers }));
    log.mockClear();

    const args = ["--key", join(dir, "key.json"), "--feedback", join(dir, "round", "feedback.json"), "--record", join(dir, "agreement.json")];
    expect(await runEvalCli(["eval", "calibrate", "agreement", ...args])).toBe(0);

    const record = AgreementRecordSchema.parse(readJson(join(dir, "agreement.json")));
    expect(record.judges.find((j) => j.judge === "l1")?.agreement).toBe(1);
    expect(record.judges.filter((j) => (j.agreement ?? 0) < 0.8).length).toBeGreaterThan(0);
    expect(printed()).toMatch(/l1\t.*may be promoted/);
    expect(printed()).toMatch(/below 0\.8/);
  });

  it("pools rounds given as repeated --key and --feedback, naming them, and leaves a judge's older version out", async () => {
    expect(await queue("--round", "1")).toBe(0);
    answer(join(dir, "feedback-1.json"));
    renameSync(join(dir, "key.json"), join(dir, "key-1.json"));
    renameSync(join(dir, "round"), join(dir, "round-1"));
    VERSION_OF["cold-scores.tsv"] = "ev-cold-2";
    expect(await queue("--round", "2")).toBe(0);
    answer(join(dir, "feedback-2.json"), (judge) => judge === "l1");
    log.mockClear();

    const args = ["--key", join(dir, "key-1.json"), "--feedback", join(dir, "feedback-1.json"), "--key", join(dir, "key.json"), "--feedback", join(dir, "feedback-2.json")];
    expect(await runEvalCli(["eval", "calibrate", "agreement", ...args, "--format", "json"])).toBe(0);

    const record = AgreementRecordSchema.parse(JSON.parse(printed()));
    const row = (judge: string) => record.judges.find((j) => j.judge === judge)!;
    expect(record.rounds).toEqual(["judge-cal-r1", "judge-cal-r2"]);
    expect(row("cold")).toMatchObject({ agreement: 1, eval_versions: ["ev-cold-2"] });
    expect(row("cold").stale).toBeGreaterThan(0);
    expect(row("l1")).toMatchObject({ stale: 0, eval_versions: ["ev-l1"] });
    expect(row("l1").labelled).toBeGreaterThan(readKey().entries.filter((e) => e.judge === "l1").length);
    expect(row("l1").agreement).toBe(0.5);
  });

  it("refuses keys and feedback files that do not pair up, or a round given twice", async () => {
    expect(await queue()).toBe(0);
    answer(join(dir, "feedback.json"));
    const key = join(dir, "key.json");
    const feedback = join(dir, "feedback.json");

    expect(await runEvalCli(["eval", "calibrate", "agreement", "--key", key, "--key", key, "--feedback", feedback])).toBe(2);
    expect(await runEvalCli(["eval", "calibrate", "agreement", "--key", key, "--feedback", feedback, "--key", key, "--feedback", feedback])).toBe(2);

    expect(error.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      expect.stringMatching(/one --feedback per --key/),
      expect.stringMatching(/round judge-cal-r1 is given twice/),
    ]);
  });

  it("prints the agreement record as JSON when asked, though calibrate itself also takes --format", async () => {
    expect(await queue()).toBe(0);
    const answers = readKey().entries.map((e) => ({ questionId: e.id, pick: `Yes (${e.id})` }));
    writeFileSync(join(dir, "round", "feedback.json"), JSON.stringify({ schema: "titan-review/feedback@1", answers }));
    log.mockClear();

    const args = ["--key", join(dir, "key.json"), "--feedback", join(dir, "round", "feedback.json"), "--format", "json"];
    expect(await runEvalCli(["eval", "calibrate", "agreement", ...args])).toBe(0);

    expect(AgreementRecordSchema.parse(JSON.parse(printed())).round).toBe("judge-cal-r1");
  });
});
