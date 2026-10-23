import { describe, expect, it } from "vitest";
import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { ResolveError } from "./resolve-beat.js";
import { resolveFixture, resolveScript, visual, wordsLong } from "./resolve-fixtures.test-helpers.js";
import { readEmphasisInput, resolveConfig, ResolvedSchema, runResolveStage } from "./resolve-stage.js";
import type { ScriptV1 } from "./script-schema.js";
import { sha256 } from "./workflow/artifacts.js";
import { failedGates, runStageChecks } from "./workflow/stage-checks.js";

/** An in-memory store over named texts that records every write, so a test can tell nothing was stored. */
function store(texts: Record<string, string>) {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const writes: string[] = [];
  const artifacts: Record<string, string> = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const put = (text: string, kind: string) => {
    writes.push(kind);
    bySha.set(sha256(text), text);
    return sha256(text);
  };
  return { artifacts, writes, store: { readText: (sha: string) => bySha.get(sha)!, putText: put } };
}

const json = (value: unknown): string => JSON.stringify(value);
const config = resolveConfig();

function run(texts: Record<string, string>) {
  const s = store(texts);
  const call = () => runResolveStage({ artifacts: s.artifacts, store: s.store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, config);
  return { ...s, call };
}

/** The resolve stage body, then its checks over the stage's inputs and outputs, as the checks step runs them. */
function stageThenChecks(texts: Record<string, string>) {
  const s = run(texts);
  const outcome = s.call();
  const artifacts = { ...s.artifacts, ...outcome.outputs };
  return { outcome, s, checks: runStageChecks("resolve", { artifacts, store: s.store, l0Checks: [] }) };
}

const cuedOnFigures = (target: string): ScriptV1 =>
  choppy({ h2: { visual: visual({ labels: ["3 sent back"], cues: [{ action: "V6", target, atCue: "parcels" }] }) } });

describe("resolve stage", () => {
  it("refuses a code beat citing a line past EOF before it writes any artifact", () => {
    const script = resolveScript([["b1", "HOW", { visual: visual({ job: "code-proof", code: { file: "src/desk.ts", lines: [11, 14] } }) }]]);
    const { call, writes } = run({ script: json(script), code: resolveFixture("code.json") });

    expect(call).toThrow(ResolveError);
    expect(call).toThrow("b1 E-RESOLVE-CITATION (past-eof: range ends at 14 but src/desk.ts has 12 lines)");
    expect(writes).toEqual([]);
  });

  it("refuses a beat no resolver row matches before it writes any artifact", () => {
    const { call, writes } = run({ script: json(resolveScript([["b1", "WHAT", { visual: visual({ job: "code-proof" }) }]])) });

    expect(call).toThrow("b1 E-RESOLVE-NO-ROW");
    expect(writes).toEqual([]);
  });

  it("writes each beat's resolution and word budgets, and notes chapters no profile block names", () => {
    const { s, outcome } = stageThenChecks({ script: json(choppy()) });

    const resolved = ResolvedSchema.parse(JSON.parse(s.store.readText(outcome.outputs.resolved!)));
    expect(s.writes).toEqual(["resolved"]);
    expect(resolved.profile).toBe("repo-tour");
    expect(resolved.beats.map((beat) => beat.beat)).toEqual(Array(12).fill("stat"));
    expect(resolved.budgets.filter((row) => row.scope === "beat")).toHaveLength(12);
    expect(outcome.notes).toEqual(["12 beats resolved by rows numbers", "no block cap for chapters ch1, ch2, ch3, ch4: no block of repo-tour has that id"]);
  });

  it("refuses to run on doctrine other than the doctrine its spec was keyed on", () => {
    const s = store({ script: json(choppy()) });

    expect(() => runResolveStage({ artifacts: s.artifacts, store: s.store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, { doctrine: "0".repeat(64) })).toThrow(/changed since this stage was keyed/);
  });

  it("gates on the word budget: a 30-word beat in a 5 s slot fails the stage", () => {
    const script = choppy({ h1: { spoken: wordsLong(30), plannedS: 5 } });

    const { checks } = stageThenChecks({ script: json(script) });

    expect(failedGates(checks.checks).map((check) => [check.name, check.detail])).toEqual([["word-budget", "1 of 12 word budgets over: beat h1 30 words > 14 (5 s at 2.8 w/s)"]]);
  });
});

describe("emphasis-target gate on the resolve stage", () => {
  it("is skipped with a note until the template fill supplies slots", () => {
    const { checks } = stageThenChecks({ script: json(cuedOnFigures("held")) });

    expect(checks.notes).toEqual(["check emphasis-target skipped: no slots artifact"]);
  });

  it("resolves a cue against the beat spec the resolver chose for the beat", () => {
    const { checks } = stageThenChecks({ script: json(cuedOnFigures("held")), slots: resolveFixture("slots.json") });

    expect(checks.checks.find((check) => check.name === "emphasis-target")).toEqual({ name: "emphasis-target", gate: true, pass: true, detail: "0 of 1 emphasis cues fail" });
  });

  it("fails the stage on a cue whose target names no element of the chosen beat", () => {
    const { checks } = stageThenChecks({ script: json(cuedOnFigures("lost")), slots: resolveFixture("slots.json") });

    expect(failedGates(checks.checks).map((check) => check.detail)).toEqual(["1 of 1 emphasis cues fail: h2#0 no-element"]);
  });

  it("reads element boxes from a layout artifact when one exists", () => {
    const layout = json({ stage: { width: 1920, height: 1080 }, boxes: { h2: { held: { x: 1900, y: 10, width: 100, height: 40 } } } });
    const texts = { script: json(cuedOnFigures("held")), slots: resolveFixture("slots.json"), layout };
    const { s, outcome } = stageThenChecks(texts);

    const input = readEmphasisInput({ artifacts: { ...s.artifacts, ...outcome.outputs }, store: s.store, l0Checks: [] });
    expect(input.layout?.boxes.h2?.held).toEqual({ x: 1900, y: 10, width: 100, height: 40 });
    expect(input.beats.find((beat) => beat.id === "h2")?.visual.beat).toBe("stat");
  });
});
