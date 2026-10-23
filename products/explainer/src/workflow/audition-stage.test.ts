import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { sha256 } from "./artifacts.js";
import { auditionConfig, runAuditionStage } from "./audition-stage.js";
import { newRuntime, openState, runOneStage, runVideo } from "./host.js";
import { runStageCli } from "./stage-cli.js";
import { stageSpec, type RunSettings } from "./stage-spec.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

/** Synthetic facts with a pending decision and an anomaly; nothing here quotes a real video. */
const FACTS = "# Facts\n\n| Id | Claim |\n|---|---|\n| F1 | The owner should adopt the new cache. |\n| F2 | The counter silently drops events. |\n";
const SETTINGS: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 1 };

function factsFile(): { file: string; sha: string } {
  const file = path.join(fx.dataDir, "facts.md");
  writeFileSync(file, FACTS);
  return { file, sha: sha256(FACTS) };
}

describe("audition stage", () => {
  it("a run from audition writes material-map.json as a content-addressed output in its report", async () => {
    fx = fixture();
    const facts = factsFile();

    const result = await runVideo({ from: "audition", to: "audition", facts: facts.file, profile: "pr-overview" }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    const row = result.report.rows.find((r) => r.stage === "audition")!;
    expect(row).toMatchObject({ status: "ran", calls: 0, usd: 0 });
    const sha = row.outputs["material-map"]!;
    const stored = readFileSync(path.join(fx.dataDir, "artifacts", sha));
    expect(sha256(stored)).toBe(sha);
    expect(JSON.parse(stored.toString())).toMatchObject({ schema: "material-map/v1", facts: { sha: facts.sha, count: 2 }, profile: { type: "pr-overview" }, candidates: ["scqa"] });
    expect(readFileSync(result.reportPath, "utf8")).toContain(`material-map ${sha.slice(0, 12)}`);
  });

  it("runs alone on stored facts, and the second run with the same key is a cache hit", async () => {
    fx = fixture();
    const facts = factsFile();
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());
    await runVideo({ from: "audition", to: "audition", facts: facts.file, profile: "pr-overview" }, host);
    const lines: string[] = [];
    const stage = () => runStageCli(["stage", "audition", "--in", `facts=${facts.sha}`, "--profile", "pr-overview", "--data-dir", fx.dataDir], { host, out: (t) => lines.push(t), err: (t) => lines.push(t) });

    expect(await stage()).toBe(0);
    expect(lines.filter((l) => l.startsWith("stage audition:")).map((l) => l.split(";")[0])).toEqual(["stage audition: cache hit"]);
    expect(lines).toContain("note: candidates (fit and allowed by pr-overview): scqa\n");
  });

  it("a run from audition with no profile is refused before it starts", async () => {
    fx = fixture();

    await expect(runVideo({ from: "audition", to: "audition", facts: factsFile().file }, fakeHost(fx, fakeScriptModel(), fakeBridge()))).rejects.toThrow(/--profile/);
  });

  it("a default run from script skips the audition", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.report.rows.find((r) => r.stage === "audition")?.status).toBe("not run");
  });
});

describe("audition stage key", () => {
  const keyed = (profile: string, artifacts = { facts: "a".repeat(64) }) =>
    stageSpec({ stage: "audition", artifacts, settings: { ...SETTINGS, profile }, sample: 0, remainingUsd: 1, bridge: () => { throw new Error("no bridge"); } });

  it("covers the facts sha, the profile version and the structure registry version", () => {
    const spec = keyed("pr-overview");

    expect(spec.inputs).toEqual({ facts: "a".repeat(64) });
    expect(spec.config).toEqual(auditionConfig("pr-overview"));
    expect(spec.config.profile).toMatchObject({ type: "pr-overview", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(spec.config.structures).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed("repo-tour").key).not.toBe(spec.key);
    expect(keyed("pr-overview", { facts: "b".repeat(64) }).key).not.toBe(spec.key);
  });

  it("a body keyed on other doctrine refuses rather than writing a map the key does not describe", () => {
    fx = fixture();
    const db = openState(fx.dataDir);
    try {
      const { store } = newRuntime(db, fakeHost(fx, fakeScriptModel(), fakeBridge()));
      const facts = store.putText(FACTS, "facts", { runId: "input", stage: "input" });
      const stale = { ...auditionConfig("pr-overview"), structures: "c".repeat(64) };
      const input = { artifacts: { facts }, store, from: { runId: "r", stage: "audition" }, remainingUsd: 1 };

      expect(() => runAuditionStage(input, stale)).toThrow(/changed since this stage was keyed/);
    } finally {
      db.close();
    }
  });

  it("one-stage runs with two profiles are two cached runs", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());
    const facts = factsFile();
    await runVideo({ from: "audition", to: "audition", facts: facts.file, profile: "pr-overview" }, host);

    const pr = await runOneStage({ stage: "audition", inputs: { facts: facts.sha }, profile: "pr-overview" }, host);
    const tour = await runOneStage({ stage: "audition", inputs: { facts: facts.sha }, profile: "repo-tour" }, host);

    expect(pr.cached).toBe(true);
    expect(tour.cached).toBeFalsy();
    expect(tour.outputs["material-map"]).not.toBe(pr.outputs["material-map"]);
  });
});
