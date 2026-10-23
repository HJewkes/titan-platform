import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgreementRecordSchema } from "./calibration-agreement.js";
import { QueueKeySchema, type QueueKey } from "./calibration-queue.js";
import { runEvalCli } from "./eval-cli.js";
import { appendTsv, scriptSha } from "./eval-store.js";
import { tour } from "./voice-flow-fixtures.test-helpers.js";

let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const SCORE = ["script_sha", "chapter", "kind", "beat", "item", "dim", "score", "void_reason"] as const;
type Score = Partial<Record<(typeof SCORE)[number], string>>;
const SCRIPT = tour();
const BEATS = SCRIPT.beats.slice(0, 6);

const tsv = (bench: string, file: string, rows: Score[]): void =>
  appendTsv(join(bench, "evals", file), SCORE, rows.map((r) => ({ void_reason: "", ...r })));

/** A synthetic bench: one judged script with cold, rubric and l1 rows that alternate pass and fail. */
function bench(name: string): { script: string; bench: string } {
  const script = join(dir, `${name}.json`);
  writeFileSync(script, JSON.stringify(SCRIPT));
  const sha = scriptSha(SCRIPT);
  const root = join(dir, `bench-${name}`);
  tsv(root, "cold-scores.tsv", BEATS.map((beat, i) => ({ script_sha: sha, chapter: beat.chapter, kind: "what-why", beat: beat.id, item: `item-${i}`, score: String(i % 3), void_reason: i % 3 === 0 ? "not stated" : "" })));
  tsv(root, "cold-rubric-scores.tsv", ["J8", "J9", "J10", "J11", "J12"].map((dim, i) => ({ script_sha: sha, dim, score: String(i + 1) })));
  tsv(root, "beat-scores.tsv", BEATS.flatMap((beat, i) => ["B1", "B3"].map((dim) => ({ script_sha: sha, beat: beat.id, dim, score: String(i % 2) }))));
  tsv(root, "beat-scores.tsv", [{ script_sha: "another", beat: BEATS[0]!.id, dim: "B1", score: "1" }, { script_sha: sha, beat: BEATS[1]!.id, dim: "B2", score: "", void_reason: "no quote" }]);
  return { script, bench: root };
}

function manifest(): string {
  const entry = (name: string, split: string, videoType: string) => ({
    case: `explainer-eval/${name}`, title: `Video ${name}`, video_type: videoType, split, owner_named: false, ...bench(name),
  });
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ schema: "calibration-manifest/v1", cases: [entry("tour", "dev", "repo-tour"), entry("held", "holdout", "repo-tour"), entry("digest", "dev", "status")] }));
  return path;
}

const printed = (): string => log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const readKey = (): QueueKey => QueueKeySchema.parse(readJson(join(dir, "key.json")));
interface Round { questions: object[]; sections: { title: string }[] }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-calibrate-judges-"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const queue = (...extra: string[]) =>
  runEvalCli(["eval", "calibrate", "queue", manifest(), "--round-dir", join(dir, "round"), "--key", join(dir, "key.json"), "--unit", "judge-cal-r1", ...extra]);

describe("explainer eval calibrate queue", () => {
  it("writes a blind round of 20 items mixed across judges and video types, with the holdout left out", async () => {
    const code = await queue();

    expect(error.mock.calls).toEqual([]);
    expect(code).toBe(0);
    const round = readJson(join(dir, "round", "round.json")) as Round;
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

  it("refuses to overwrite a round that is already published", async () => {
    expect(await queue()).toBe(0);
    expect(await queue()).toBe(2);
  });
});

describe("explainer eval calibrate agreement", () => {
  it("reports agreement per judge from the round's feedback and records it, still refusing promotion below the bar", async () => {
    expect(await queue()).toBe(0);
    const answers = readKey().entries.map((e, i) => ({
      questionId: e.id, pick: e.judge === "l1" || i % 2 === 0 ? (e.pass ? "Yes" : "No") : e.pass ? "No" : "Yes",
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
});
