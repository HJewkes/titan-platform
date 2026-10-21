import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildJudgePrefix, CONFIRM_ROLE, SCREEN_ROLE } from "../judge/index.js";
import { CHAIN, fakeJudges, fixture, SPEC, WINS, type Behave, type Fixture } from "./fake-judges.test-helpers.js";
import { COMPILE_ROLE } from "./compile.js";
import { ask, resume, type AskOptions, type HostOptions } from "./host.js";
import { batchArtifactSchema, CostEntrySchema } from "./records.js";
import { readJson, runPaths, sha256 } from "./run-dir.js";

const QUESTION = "List every trophy the Gull Rovers won";

let fx: Fixture;
afterEach(() => fx.cleanup());

/** One passage per batch, so each chapter is its own judge call. */
const options = (overrides: Partial<AskOptions> = {}): AskOptions => ({ question: QUESTION, corpus: fx.root, index: fx.index, spec: SPEC, batchTokens: 1, concurrency: 1, ...overrides });

const host = (runnerFor: HostOptions["runnerFor"], extra: Partial<HostOptions> = {}): HostOptions => ({ dataDir: fx.dataDir, runnerFor, ...extra });

function recordedSteps(runId: string): string[] {
  const db = openDatabase(path.join(fx.dataDir, "state.sqlite3"));
  try {
    return Object.values(new WorkflowRunStore(db).get(runId)!.stepResults).map((r) => r.stepId);
  } finally {
    db.close();
  }
}

const screenCalls = (calls: ReturnType<typeof fakeJudges>["calls"]) => calls.filter((c) => c.stage === "screen");

const refuse = (ref: string): Behave => (call) => (call.stage === "screen" && call.refs.includes(ref) ? { ok: false, error: "refusal: the model declined", retryable: false } : undefined);

describe("ask", () => {
  it("compiles the question in its own run, then answers in a second run keyed by the stored spec", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges();

    const result = await ask(options({ spec: undefined }), host(judges.runnerFor));

    const db = openDatabase(path.join(fx.dataDir, "state.sqlite3"));
    const store = new WorkflowRunStore(db);
    expect(store.get(result.compileRunId!)?.workflowName).toBe("cq-compile");
    const answerRun = store.get(result.runId)!;
    db.close();
    expect(answerRun).toMatchObject({ workflowName: "cq-answer", status: "completed" });
    expect(answerRun.params.specSha).toBe(sha256(readFileSync(path.join(fx.dataDir, "specs", `${answerRun.params.specSha}.json`), "utf8")));
    expect(judges.calls[0]).toMatchObject({ stage: "compile", model: "sonnet", systemPrompt: COMPILE_ROLE });
    expect(judges.calls.slice(1).every((c) => c.stage !== "compile")).toBe(true);
  });

  it("writes one cost line per model call, the compile call included, with no invented token counts", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges();

    const result = await ask(options({ spec: undefined }), host(judges.runnerFor));

    const cost = readJson(runPaths(fx.dataDir, result.runId).cost, z.array(CostEntrySchema))!;
    expect(cost.map((c) => `${c.stage}/${c.model}`).sort()).toEqual(judges.calls.map((c) => `${c.stage}/${c.model}`).sort());
    expect(cost[0]).toEqual({ stage: "compile", model: "sonnet", cliCostUsd: 0.01 });
  });

  it("routes screen calls to haiku and confirm calls to sonnet, each under its own fixed prefix", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges();

    await ask(options(), host(judges.runnerFor));

    const prefix = (role: string) => buildJudgePrefix({ role, question: QUESTION, spec: SPEC });
    const byStage = (stage: string) => new Set(judges.calls.filter((c) => c.stage === stage).map((c) => `${c.model}|${c.systemPrompt}`));
    expect(byStage("screen")).toEqual(new Set([`haiku|${prefix(SCREEN_ROLE)}`]));
    expect(byStage("confirm")).toEqual(new Set([`sonnet|${prefix(CONFIRM_ROLE)}`]));
  });

  it("finishes the warm call before launching any other call of the wave", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges({ delayMs: 20 });

    await ask(options({ concurrency: 4 }), host(judges.runnerFor));

    const [warm, ...rest] = screenCalls(judges.calls);
    expect(rest).toHaveLength(4);
    for (const call of rest) expect(call.startedAt).toBeGreaterThanOrEqual(warm!.endedAt!);
    expect(Math.max(...rest.map((c) => c.startedAt))).toBeLessThan(Math.min(...rest.map((c) => c.endedAt!)));
  });

  it("redoes a refused batch once on sonnet, records it unjudged, and still judges every other batch", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges({ behave: refuse("GR 1.2") });

    const result = await ask(options(), host(judges.runnerFor));

    const refused = screenCalls(judges.calls).filter((c) => c.refs.includes("GR 1.2"));
    expect(refused.map((c) => c.model)).toEqual(["haiku", "sonnet"]);
    expect(result.status).toBe("completed");
    const { screen } = result.answer!.coverage;
    expect(screen).toMatchObject({ retrieved: 5, judged: 4, skipped: [] });
    expect(screen.unjudged).toEqual([expect.stringMatching(/^gull-rovers\/1\/2#/)]);
    expect(result.answer!.rows.map((r) => r.period)).toEqual(["GR 1.1", "GR 1.3", "GR 2.1", "GR 2.2"]);
  });

  it("counts a batch whose first payload fails its schema once the sonnet redo answers", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges({ behave: (call) => (call.stage === "screen" && call.model === "haiku" && call.refs.includes("GR 2.1") ? { ok: true, output: "not json" } : undefined) });

    const result = await ask(options(), host(judges.runnerFor));

    const calls = screenCalls(judges.calls).filter((c) => c.refs.includes("GR 2.1"));
    expect(calls.map((c) => c.model)).toEqual(["haiku", "sonnet"]);
    expect(result.answer!.coverage.screen).toMatchObject({ judged: 5, unjudged: [] });
    expect(result.answer!.rows).toHaveLength(5);
  });

  it("grows the lexicon until no reported name is new, then stops before the round cap", async () => {
    fx = fixture([...WINS, ...CHAIN]);
    const judges = fakeJudges({ names: { "Pebble Cup": ["Kestrel Shield"], "Kestrel Shield": ["kestrel shield", "Pebble Cup"] } });

    const result = await ask(options({ rounds: 2, spec: { ...SPEC, seedLexicon: ["Pebble Cup"] } }), host(judges.runnerFor));

    expect(result.answer!.rounds).toBe(2);
    expect(recordedSteps(result.runId).filter((id) => /^(retrieve|grow):/.test(id))).toEqual(["retrieve:r0", "grow:r1"]);
    expect(screenCalls(judges.calls).filter((c) => c.stepId.startsWith("screen:r1")).flatMap((c) => c.refs)).toEqual(["GR 3.1"]);
    expect(judges.calls.some((c) => c.stepId.startsWith("screen:r2"))).toBe(false);
  });

  it("retrieves a grown name only beside the spec's event words", async () => {
    fx = fixture([...WINS, ...CHAIN]);
    const judges = fakeJudges({ names: { "Pebble Cup": ["Kestrel Shield"] } });

    await ask(options(), host(judges.runnerFor));

    const shown = judges.calls.flatMap((c) => c.refs);
    expect(shown).toContain("GR 3.1");
    expect(shown).not.toContain("GR 4.1");
  });

  it("stops growing at the round cap while judges keep reporting new names", async () => {
    fx = fixture([...WINS, ...CHAIN]);
    const judges = fakeJudges({ names: { "Pebble Cup": ["Kestrel Shield"], "Kestrel Shield": ["Osprey Plate"], "Osprey Plate": ["Heron Bowl"] } });

    const result = await ask(options({ rounds: 2 }), host(judges.runnerFor));

    expect(result.answer!.rounds).toBe(3);
    const shown = judges.calls.flatMap((c) => c.refs);
    expect(shown).toEqual(expect.arrayContaining(["GR 3.1", "GR 3.2"]));
    expect(shown).not.toContain("GR 3.3");
  });

  it("confirms once per book, each call holding only that book's candidate passages", async () => {
    fx = fixture(WINS);
    const judges = fakeJudges();

    const result = await ask(options({ concurrency: 4 }), host(judges.runnerFor));

    const confirms = judges.calls.filter((c) => c.stage === "confirm").map((c) => c.refs);
    expect(confirms).toEqual([["GR 1.1", "GR 1.2", "GR 1.3"], ["GR 2.1", "GR 2.2"]]);
    expect(result.answer!.rows.map((r) => `${r.ref}|${r.book}`)).toEqual(["GR 1.1|gull-rovers/book_01", "GR 1.2|gull-rovers/book_01", "GR 1.3|gull-rovers/book_01", "GR 2.1|gull-rovers/book_02", "GR 2.2|gull-rovers/book_02"]);
  });
});

describe("confirm input", () => {
  it("sends wins and recaps to confirm but never a preview", async () => {
    fx = fixture([...WINS, { ...WINS[4]!, relPath: "gull-rovers/book_02/chapter_03.txt", title: "2.3 - Matchday", body: "The Gull Rovers won the semi. The Tide Cup final is next week." }]);
    const judges = fakeJudges();

    await ask(options(), host(judges.runnerFor));

    expect(screenCalls(judges.calls).flatMap((c) => c.refs)).toContain("GR 2.3");
    expect(judges.calls.filter((c) => c.stage === "confirm").flatMap((c) => c.refs)).not.toContain("GR 2.3");
  });
});

describe("resume", () => {
  it("after a crash dispatches only the batches that had not finished, never repaying an unjudged one", async () => {
    fx = fixture(WINS);
    const crash = new AbortController();
    const hang: Behave = (call, input) => {
      if (!(call.stage === "screen" && call.refs.includes("GR 2.1"))) return refuse("GR 1.2")(call, input);
      setTimeout(() => crash.abort(), 0);
      return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted", retryable: false })));
    };
    const first = await ask(options(), host(fakeJudges({ behave: hang }).runnerFor, { signal: crash.signal }));
    expect(first.status).toBe("running");

    const second = fakeJudges();
    const resumed = await resume(first.runId, host(second.runnerFor));

    expect(resumed.status).toBe("completed");
    expect(screenCalls(second.calls).flatMap((c) => c.refs)).toEqual(["GR 2.1", "GR 2.2"]);
    const round = path.dirname(runPaths(fx.dataDir, first.runId).batch("screen", "k", 0));
    const artifacts = readdirSync(round).map((f) => readJson(path.join(round, f), batchArtifactSchema(z.unknown()))!);
    expect(artifacts.filter((a) => a.via === "unjudged").map((a) => a.passageIds)).toEqual([[expect.stringMatching(/^gull-rovers\/1\/2#/)]]);
    expect(resumed.answer!.coverage.screen).toMatchObject({ judged: 4, skipped: [] });
  });
});
