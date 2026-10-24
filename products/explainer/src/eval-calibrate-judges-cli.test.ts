import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const SCORE = ["config_id", "run", "script_sha", "chapter", "kind", "beat", "item", "dim", "score", "void_reason"] as const;
type Score = Partial<Record<(typeof SCORE)[number], string>>;
const SCRIPT = tour();
const BEATS = SCRIPT.beats.slice(0, 6);

const tsv = (bench: string, file: string, rows: Score[]): void =>
  appendTsv(join(bench, "evals", file), SCORE, rows.map((r) => ({ void_reason: "", ...r })));

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

function manifest(extra: Record<string, unknown> = {}): string {
  const entry = (name: string, split: string, videoType: string) => ({
    case: `explainer-eval/${name}`, title: `Video ${name}`, video_type: videoType, split, owner_named: false, ...bench(name),
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
  dir = mkdtempSync(join(tmpdir(), "explainer-calibrate-judges-"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const queue = (...extra: string[]) => queueFrom(manifest(), ...extra);
const queueFrom = (path: string, ...extra: string[]) =>
  runEvalCli(["eval", "calibrate", "queue", path, "--round-dir", join(dir, "round"), "--key", join(dir, "key.json"), "--unit", "judge-cal-r1", ...extra]);

describe("explainer eval calibrate queue", () => {
  it("writes a blind round of 20 items mixed across judges and video types, with the holdout left out", async () => {
    const code = await queue();

    expect(error.mock.calls).toEqual([]);
    expect(code).toBe(0);
    const round = RoundSchema.parse(readJson(join(dir, "round", "round.json")));
    const key = readKey();
    expect(round).toMatchObject({ schema: "titan-review/round@2", unit: "judge-cal-r1", variants: [] });
    expect(round.questions).toHaveLength(20);
    expect(round.sections.map((s) => s.title)).toEqual(["Video digest", "Video tour"]);
    expect(new Set(key.entries.map((e) => e.judge))).toEqual(new Set(["cold", "cold-rubric", "l1"]));
    expect(new Set(key.entries.filter((e) => e.judge === "cold").map((e) => e.pass))).toEqual(new Set([true, false]));
    expect(key.entries.some((e) => e.case.endsWith("held"))).toBe(false);
    expect(round.questions.filter((q) => "recommendation" in q)).toEqual([]);
    expect(JSON.stringify(round)).not.toMatch(/cold-rubric|"judge"|"pass"/);
    expect(JSON.parse(printed())).toMatchObject({ items: 20, minutes: 35 });
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

  it("refuses to overwrite a round that is already published", async () => {
    expect(await queue()).toBe(0);
    expect(await queue()).toBe(2);
  });
});

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
