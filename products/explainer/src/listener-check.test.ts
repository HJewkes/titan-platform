import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgeHarness } from "./eval-harness.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { ask, fakeListener, quiet } from "./listener-fakes.test-helpers.js";
import { LISTENER_PROMPT } from "./listener-questions.js";
import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { sha256 } from "./workflow/artifacts.js";
import { runVideo } from "./workflow/host.js";
import { runRunCli } from "./workflow/run-cli.js";
import { runPaths } from "./workflow/run-dir.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./workflow/run-fakes.test-helpers.js";
import { failedGates, runJudgedChecks, type CheckInput } from "./workflow/stage-checks.js";

const oneEach = () => fakeListener((sentences) => ({ ...quiet(), questions: [...sentences.keys()].map((id) => ask(id, `What about ${id}?`)) }));

function input(texts: Record<string, string>): CheckInput {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  return { artifacts: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)])), store: { readText: (sha) => bySha.get(sha)! }, l0Checks: [] };
}

const draft = () => input({ draft: JSON.stringify(choppy()) });
const chapters = new Set(choppy().beats.map((b) => b.chapter)).size;

describe("the listener-questions script check", () => {
  it("reports per-chapter counts on the draft, with the listener's spend as the step's", async () => {
    const listener = oneEach();

    const run = await runJudgedChecks("script", draft(), { config: sonnet, harness: listener.harness });

    expect(run.checks).toEqual([{ name: "listener-questions", gate: false, pass: true, detail: expect.stringMatching(/^\d+ questions over \d+ sentences \(1\.00 a sentence\); /) }]);
    expect(run.usage).toMatchObject({ calls: chapters, inputTokens: 400 * chapters });
    expect(run.usage.usd).toBeCloseTo(0.02 * chapters);
  });

  it("reports red above its threshold, and is never a gate", async () => {
    const run = await runJudgedChecks("script", draft(), { config: sonnet, harness: oneEach().harness, listenerThreshold: 0.5 });

    expect(run.checks[0]).toMatchObject({ gate: false, pass: false, detail: expect.stringContaining("; over 0.5 a sentence: ") });
    expect(failedGates(run.checks)).toEqual([]);
  });

  it("does not run, or spend, on a run that names no judge", async () => {
    expect(await runJudgedChecks("script", draft(), undefined)).toEqual({ checks: [], notes: [], usage: expect.objectContaining({ calls: 0, usd: 0 }) });
  });

  it("skips with a note when the stage made no draft", async () => {
    const run = await runJudgedChecks("script", input({}), { config: sonnet, harness: oneEach().harness });

    expect(run).toMatchObject({ checks: [], notes: ["check listener-questions skipped: no draft artifact"] });
  });

  it("reports a listener that throws as a check that could not run", async () => {
    const harness: JudgeHarness = async () => {
      throw new Error("spawn failed");
    };

    const run = await runJudgedChecks("script", draft(), { config: sonnet, harness });

    expect(run.checks).toEqual([{ name: "listener-questions", gate: false, pass: false, detail: "could not run: spawn failed" }]);
  });
});

describe("the listener-questions check in a run", () => {
  let fx: Fixture;
  afterEach(() => fx.cleanup());

  const listening = (listener: ReturnType<typeof fakeListener>) => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(undefined, { usd: 0.05 }), fakeBridge());
    const base = host.harnessFor!(sonnet);
    const harness: JudgeHarness = (call) => (call.prompt.startsWith(LISTENER_PROMPT) ? listener.harness(call) : base(call));
    return { ...host, harnessFor: () => harness };
  };

  it("adds a reported verdict to the script stage's row and its spend to the stage", async () => {
    const host = { ...listening(oneEach()), listener: {} };

    const run = await runVideo({ spine: fx.spine, facts: fx.facts }, host);

    const script = run.report.rows.find((r) => r.stage === "script")!;
    expect(run.status, run.error).toBe("completed");
    expect(script).toMatchObject({ calls: 1 + chapters });
    expect(script.usd).toBeCloseTo(0.05 + 0.02 * chapters);
    expect(readFileSync(run.reportPath, "utf8")).toMatch(/\| script \| listener-questions \| reported \| pass \| \d+ questions over/);
  });

  it("runs from the CLI under --listener-threshold, exiting 0 on a red verdict", async () => {
    const host = listening(oneEach());
    const out: string[] = [];

    const code = await runRunCli(["run", "--spine", fx.spine, "--facts", fx.facts, "--to", "script", "--listener-threshold", "0", "--data-dir", fx.dataDir], { host, out: (t) => out.push(t), err: () => {} });

    expect(code).toBe(0);
    const runId = /^run (\S+):/.exec(out[0] ?? "")![1]!;
    expect(readFileSync(runPaths(fx.dataDir, runId).reportMd, "utf8")).toMatch(/\| script \| listener-questions \| reported \| \*\*fail\*\* \| .*; over 0 a sentence: /);
  });

  it("leaves the script stage alone when the run does not ask for it", async () => {
    const listener = oneEach();
    const host = listening(listener);

    const run = await runVideo({ spine: fx.spine, facts: fx.facts }, host);

    expect(listener.prompts).toEqual([]);
    expect(run.report.rows.find((r) => r.stage === "script")).toMatchObject({ calls: 1 });
  });
});
