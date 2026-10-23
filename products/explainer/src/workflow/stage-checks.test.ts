import { describe, expect, it } from "vitest";
import type { L0Check } from "../eval-l0.js";
import { DEFAULT_JUDGE } from "./host.js";
import { runEvalStage, StageFailure } from "./model-stages.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import type { ScriptV1 } from "../script-schema.js";
import { sha256 } from "./artifacts.js";
import { l0Check, SPINE } from "./run-fakes.test-helpers.js";
import { failedGates, runStageChecks, STAGE_CHECKS, type CheckInput } from "./stage-checks.js";

/** An in-memory store over named texts: the artifact map points each name at its text's sha. */
function input(texts: Record<string, string>, l0Checks: readonly L0Check[] = [l0Check(true)]): CheckInput {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const artifacts = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  return { artifacts, store: { readText: (sha) => bySha.get(sha)! }, l0Checks };
}

const json = (value: unknown): string => JSON.stringify(value);
const verdict = (run: ReturnType<typeof runStageChecks>, name: string) => run.checks.find((check) => check.name === name);
const warning = (pass: boolean): L0Check => () => [{ check_id: "fake-warn", mode: "tagged", severity: "warning", value: pass ? 0 : 1, threshold: 0, pass, detail_beats: [] }];

/** h1 shows a V6 card on "courier", a word h1 speaks. */
const cued = (): ScriptV1 => choppy({ h1: { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", cues: [{ action: "V6", target: "card", atCue: "courier" }] } } });

function words(script: ScriptV1, drop?: string): string {
  const beats = script.beats.map((beat) => {
    const spoken = beat.spoken.split(/\s+/).filter((word) => word !== drop);
    return { id: beat.id, durationS: spoken.length + 1, words: spoken.map((word, i) => ({ word, start: i, end: i + 1 })) };
  });
  return json({ beats });
}

describe("script stage checks", () => {
  it("gates on an error-severity L0 row and only reports a failing warning row", () => {
    const run = runStageChecks("script", input({ draft: json(choppy()), spine: SPINE }, [l0Check(false), warning(false)]));

    expect(verdict(run, "l0")).toMatchObject({ gate: true, pass: false, detail: expect.stringContaining("fake-l0") });
    expect(verdict(run, "l0-warnings")).toMatchObject({ gate: false, pass: false, detail: expect.stringContaining("fake-warn (warning)") });
    expect(failedGates(run.checks).map((check) => check.name)).toEqual(["l0"]);
  });

  it("passes l0 when only a warning row fails", () => {
    const run = runStageChecks("script", input({ draft: json(choppy()), spine: SPINE }, [l0Check(true), warning(false)]));

    expect(verdict(run, "l0")).toMatchObject({ pass: true });
  });

  it("gates on an error-severity pace row: a beat bringing five new terms", () => {
    const crowded = choppy({ h1: { new_terms: ["scan", "label", "dock", "ledger row", "courier app"] } });

    const run = runStageChecks("script", input({ draft: json(crowded), spine: SPINE }));

    expect(verdict(run, "pace")).toMatchObject({ gate: true, pass: false, detail: expect.stringContaining("Q-E7") });
  });

  it("passes pace on the plain draft", () => {
    expect(verdict(runStageChecks("script", input({ draft: json(choppy()), spine: SPINE })), "pace")).toMatchObject({ pass: true });
  });
});

describe("rewrite stage checks", () => {
  const draft = choppy();
  const rewritten = { ...draft, id: `${draft.id}-rw` };
  const failsOnRewrite: L0Check = (l0) => l0Check(!l0.script.id.endsWith("-rw"))(l0);
  const report = (pass: boolean) => json({ after: [{ check_id: "triads", value: 3, threshold: 1, pass }] });

  it("gates on an error row the rewrite turned red", () => {
    const run = runStageChecks("rewrite", input({ draft: json(draft), script: json(rewritten), "rewrite-report": report(true) }, [failsOnRewrite]));

    expect(verdict(run, "no-new-l0-error")).toMatchObject({ gate: true, pass: false, detail: "new failing error rows: fake-l0" });
  });

  it("passes when the error row was already red on the draft", () => {
    const run = runStageChecks("rewrite", input({ draft: json(draft), script: json(rewritten), "rewrite-report": report(true) }, [l0Check(false)]));

    expect(verdict(run, "no-new-l0-error")).toMatchObject({ pass: true });
  });

  it("reports a red target row without gating", () => {
    const run = runStageChecks("rewrite", input({ draft: json(draft), script: json(rewritten), "rewrite-report": report(false) }));

    expect(verdict(run, "rewrite-rows")).toMatchObject({ gate: false, pass: false, detail: "1 of 1 target rows red: triads" });
    expect(failedGates(run.checks)).toEqual([]);
  });
});

describe("tts stage checks", () => {
  it("passes when every cue lands on a voiced word", () => {
    const script = cued();

    const run = runStageChecks("tts", input({ script: json(script), words: words(script) }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ gate: true, pass: true, detail: "1 of 1 cues resolve" });
  });

  it("gates on a cue whose word the voice never spoke", () => {
    const script = cued();

    const run = runStageChecks("tts", input({ script: json(script), words: words(script, "courier") }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ gate: true, pass: false, detail: "0 of 1 cues resolve; unresolved: h1:courier" });
  });
});

describe("running a stage's checks", () => {
  it("skips a check whose artifact the stage did not produce, with a note instead of a verdict", () => {
    const run = runStageChecks("tts", input({ script: json(cued()) }));

    expect(run.checks).toEqual([]);
    expect(run.notes).toEqual(["check cue-resolution skipped: no words artifact"]);
  });

  it("fails a check that cannot read its artifact, naming why", () => {
    const run = runStageChecks("tts", input({ script: json(cued()), words: "not json" }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ pass: false, detail: expect.stringMatching(/^could not run: /) });
  });

  it("declares every check either a gate or reported", () => {
    const roles = Object.fromEntries(Object.entries(STAGE_CHECKS).map(([stage, checks]) => [stage, checks.map((c) => `${c.name}:${c.gate ? "gate" : "reported"}`)]));

    expect(roles).toEqual({
      audition: [],
      script: ["l0:gate", "l0-warnings:reported", "pace:gate"],
      rewrite: ["no-new-l0-error:gate", "rewrite-rows:reported"],
      eval: [], resolve: ["emphasis-target:gate", "word-budget:gate"], tts: ["cue-resolution:gate"], render: [], qa: [], sheets: [],
    });
  });
});

describe("eval stage gates", () => {
  it("fails with its gate verdicts attached, before the rubric spends", async () => {
    const { artifacts, store } = input({ script: json(choppy()), spine: SPINE });
    const stage = { artifacts, store: { ...store, putText: () => "unused" }, from: { runId: "r", stage: "eval" }, remainingUsd: 1 };
    let judged = 0;

    const run = runEvalStage(stage, { judge: DEFAULT_JUDGE, harnessFor: () => { judged++; throw new Error("no judge"); } }, [l0Check(false)]);

    await expect(run).rejects.toBeInstanceOf(StageFailure);
    await expect(run).rejects.toMatchObject({ checks: [{ name: "l0", gate: true, pass: false }, { name: "pace", gate: true, pass: true }] });
    expect(judged).toBe(0);
  });
});
