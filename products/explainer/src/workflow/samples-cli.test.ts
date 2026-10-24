import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAaFloorCli } from "../aa-floor-cli.js";
import { ArtifactStore } from "./artifacts.js";
import { openState } from "./host.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";
import { runAbCli } from "./samples-cli.js";
import { runStageCli } from "./stage-cli.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

/** Stores the fixture's spine and facts and returns their shas, as an ev case's `input.inputs`. */
function storedInputs(): { spine: string; facts: string } {
  const db = openState(fx.dataDir);
  try {
    const store = new ArtifactStore(fx.dataDir, db);
    const from = { runId: "test", stage: "input" };
    return { spine: store.putText(readFileSync(fx.spine, "utf8"), "spine", from), facts: store.putText(readFileSync(fx.facts, "utf8"), "facts", from) };
  } finally {
    db.close();
  }
}

function casesDir(inputs: Record<string, string>): string {
  const dir = path.join(fx.dataDir, "unit", "cases");
  mkdirSync(dir, { recursive: true });
  for (const [id, split] of [["case-dev", "dev"], ["case-holdout", "holdout"]]) {
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ schema: "titan.case/v1", id, input: { inputs }, split }));
  }
  return dir;
}

function setup() {
  fx = fixture();
  const model = fakeScriptModel(undefined, { usd: 0.05 });
  const host = fakeHost(fx, model, fakeBridge());
  const out: string[] = [];
  const err: string[] = [];
  const deps = { host, out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  return { model, out, err, deps, inputs: storedInputs() };
}

describe("explainer stage --samples", () => {
  it("runs n distinct samples of the stage and reports each target row through summarizeMeasure", async () => {
    const { model, out, deps, inputs } = setup();
    const argv = ["stage", "script", "--in", `spine=${inputs.spine}`, "--in", `facts=${inputs.facts}`, "--samples", "2", "--data-dir", fx.dataDir];

    expect(await runStageCli(argv, deps)).toBe(0);
    const text = out.join("");

    expect(model.prompts).toHaveLength(2);
    expect(text).toMatch(/\| in \| register:numbers \| <= 25\.62 \| — \| [\d.]+ ± 0\.00 \| 2 \|/);
    expect(text).toContain("Every target row in band or within 1σ:");
    expect(text).toContain("Spend: $0.1000 over 2 runs (0 cache hits, 0 without a script).");
  });

  it("reuses the cached samples on a second measure", async () => {
    const { model, out, deps, inputs } = setup();
    const argv = ["stage", "script", "--in", `spine=${inputs.spine}`, "--in", `facts=${inputs.facts}`, "--samples", "2", "--data-dir", fx.dataDir];

    await runStageCli(argv, deps);
    out.length = 0;
    await runStageCli(argv, deps);

    expect(model.prompts).toHaveLength(2);
    expect(out.join("")).toContain("Spend: $0.0000 over 2 runs (2 cache hits, 0 without a script).");
  });

  it("refuses --samples on a stage that writes no script, with exit 2", async () => {
    const { err, deps } = setup();

    expect(await runStageCli(["stage", "tts", "--samples", "2", "--data-dir", fx.dataDir], deps)).toBe(2);
    expect(err.join("")).toContain("--samples measures a model stage that writes a script: script, rewrite; got tts");
  });
});

describe("explainer aa-floor and ab", () => {
  it("aa-floor writes σ to the unit's notes, and ab reads that floor and calls an identical pair noise", async () => {
    const { model, out, deps, inputs } = setup();
    const cases = casesDir(inputs);
    const unitDir = path.dirname(cases);
    const settings = ["--data-dir", fx.dataDir];

    expect(await runAaFloorCli(["aa-floor", "--stage", "script", "--cases", cases, "--samples", "2", "--unit-dir", unitDir, ...settings], deps)).toBe(0);
    expect(model.prompts).toHaveLength(4);
    expect(readFileSync(path.join(unitDir, "notes.md"), "utf8")).toContain("2 samples per arm over 1 cases (case-dev); 4 runs, 0 failed, $0.20.");

    out.length = 0;
    expect(await runAbCli(["ab", "--stage", "script", "--variants", "champion", "champion", "--cases", cases, "--samples", "2", "--floor", unitDir, ...settings], deps)).toBe(0);

    expect(model.prompts).toHaveLength(4);
    expect(out.join("")).toMatch(/\| register:numbers \| [\d.]+ \| [\d.]+ \| \+0\.000 \| 0\.000 \(floor\) \| ± 0\.000 \| noise \|/);
  });

  it("ab refuses one variant, and a floor measured on another stage", async () => {
    const { err, deps, inputs } = setup();
    const cases = casesDir(inputs);
    writeFileSync(path.join(fx.dataDir, "floor.json"), JSON.stringify({
      schema: "explainer.aa-floor/v1", stage: "rewrite", stageVersion: "x4", measuredAt: "t", cases: [], samplesPerArm: 1, sigma: {}, rows: [], spentUsd: 0, runs: 0, failedRuns: 0,
    }));
    const ab = (...argv: string[]) => runAbCli(["ab", "--stage", "script", "--cases", cases, "--samples", "1", "--data-dir", fx.dataDir, ...argv], deps);

    expect(await ab("--variants", "champion")).toBe(2);
    expect(await ab("--variants", "champion", "champion", "--floor", path.join(fx.dataDir, "floor.json"))).toBe(2);
    expect(err.join("")).toContain("--variants takes exactly two, A then B; got 1");
    expect(err.join("")).toContain("--floor is the rewrite stage's floor, not script's");
  });
});
