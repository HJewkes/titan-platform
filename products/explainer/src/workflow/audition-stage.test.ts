import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { parseSpine } from "../spine-schema.js";
import { sha256 } from "./artifacts.js";
import { auditionConfig, runAuditionStage } from "./audition-stage.js";
import { newRuntime, openState, runOneStage, runVideo } from "./host.js";
import { runStageCli } from "./stage-cli.js";
import { stageSpec, type RunSettings } from "./stage-spec.js";
import { fakeAuditionModel } from "../audition-fakes.test-helpers.js";
import { throwingRubric } from "../cold-rubric-fakes.test-helpers.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

/** Synthetic facts with a pending decision and an anomaly; nothing here quotes a real video. */
const FACTS = "# Facts\n\n| Id | Claim |\n|---|---|\n| F1 | The owner should adopt the new cache. |\n| F2 | The counter silently drops events. |\n";
const MODELS = { model: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }) };
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

    const result = await runVideo({ from: "audition", to: "audition", facts: facts.file, profile: "pr-overview" }, fakeHost(fx, fakeAuditionModel(), fakeRender()));

    expect(result.status, result.error).toBe("completed");
    const row = result.report.rows.find((r) => r.stage === "audition")!;
    expect(row).toMatchObject({ status: "ran", calls: 4, usd: 0.13 });
    const sha = row.outputs["material-map"]!;
    const stored = readFileSync(path.join(fx.dataDir, "artifacts", sha));
    expect(sha256(stored)).toBe(sha);
    expect(JSON.parse(stored.toString())).toMatchObject({ schema: "material-map/v1", facts: { sha: facts.sha, count: 2 }, profile: { type: "pr-overview" }, candidates: ["scqa"] });
    expect(readFileSync(result.reportPath, "utf8")).toContain(`material-map ${sha.slice(0, 12)}`);
  });

  it("runs alone on stored facts, and the second run with the same key is a cache hit", async () => {
    fx = fixture();
    const facts = factsFile();
    const host = fakeHost(fx, fakeAuditionModel(), fakeRender());
    await runVideo({ from: "audition", to: "audition", facts: facts.file, profile: "pr-overview" }, host);
    const lines: string[] = [];
    const stage = () => runStageCli(["stage", "audition", "--in", `facts=${facts.sha}`, "--profile", "pr-overview", "--data-dir", fx.dataDir], { host, out: (t) => lines.push(t), err: (t) => lines.push(t) });

    expect(await stage()).toBe(0);
    expect(lines.filter((l) => l.startsWith("stage audition:")).map((l) => l.split(";")[0])).toEqual(["stage audition: cache hit"]);
    expect(lines).toContain("note: candidates (fit and allowed by pr-overview): scqa\n");
  });

  it("a run from audition with no profile is refused before it starts", async () => {
    fx = fixture();

    await expect(runVideo({ from: "audition", to: "audition", facts: factsFile().file }, fakeHost(fx, fakeAuditionModel(), fakeRender()))).rejects.toThrow(/--profile/);
  });

  it("a run from audition to script needs --spine for a profile whose spine is not its audition pick", async () => {
    fx = fixture();

    await expect(runVideo({ from: "audition", to: "script", facts: factsFile().file, profile: "repo-tour" }, fakeHost(fx, fakeAuditionModel(), fakeRender()))).rejects.toThrow(/--spine/);
  });

  it("writes the pick as the spine for pr-overview, so a run to script needs no --spine", async () => {
    fx = fixture();

    const result = await runVideo({ from: "audition", to: "audition", facts: factsFile().file, profile: "pr-overview" }, fakeHost(fx, fakeAuditionModel(), fakeRender()));

    const spine = result.report.rows.find((r) => r.stage === "audition")!.outputs.spine!;
    expect(readFileSync(path.join(fx.dataDir, "artifacts", spine), "utf8")).toMatch(/^# Story spine: pr-overview-scqa\n/);
  });

  it("writes the pick as the spine for daily-overview too, naming its structure and each chapter's lead beat", async () => {
    fx = fixture();

    const result = await runVideo({ from: "audition", to: "audition", facts: factsFile().file, profile: "daily-overview" }, fakeHost(fx, fakeAuditionModel(), fakeRender()));

    expect(result.status, result.error).toBe("completed");
    const spine = result.report.rows.find((r) => r.stage === "audition")!.outputs.spine;
    expect(spine).toBeDefined();
    const parsed = parseSpine(readFileSync(path.join(fx.dataDir, "artifacts", spine!), "utf8"));
    expect(parsed.id).toMatch(/^daily-overview-/);
    expect(parsed.structure).toBe(parsed.id.replace("daily-overview-", ""));
    expect(parsed.chapters.every((chapter) => chapter.beat !== undefined)).toBe(true);
  });

  it("a default run from script skips the audition", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(result.report.rows.find((r) => r.stage === "audition")?.status).toBe("not run");
  });
});

describe("audition stage key", () => {
  const keyed = (profile: string, artifacts = { facts: "a".repeat(64) }) =>
    stageSpec({ stage: "audition", artifacts, settings: { ...SETTINGS, profile }, sample: 0, remainingUsd: 1, bridge: () => { throw new Error("no bridge"); } });

  it("covers the facts sha, the profile version and the structure registry version", () => {
    const spec = keyed("pr-overview");

    expect(spec.inputs).toEqual({ facts: "a".repeat(64) });
    expect(spec.config).toEqual(auditionConfig("pr-overview", MODELS));
    expect(spec.config.profile).toMatchObject({ type: "pr-overview", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(spec.config.structures).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed("repo-tour").key).not.toBe(spec.key);
    expect(keyed("pr-overview", { facts: "b".repeat(64) }).key).not.toBe(spec.key);
  });

  it("a body keyed on other doctrine refuses rather than writing a map the key does not describe", async () => {
    fx = fixture();
    const db = openState(fx.dataDir);
    try {
      const { store } = newRuntime(db, fakeHost(fx, fakeAuditionModel(), fakeRender()));
      const facts = store.putText(FACTS, "facts", { runId: "input", stage: "input" });
      const stale = { ...auditionConfig("pr-overview", MODELS), structures: "c".repeat(64) };
      const input = { artifacts: { facts }, store, from: { runId: "r", stage: "audition" }, remainingUsd: 1 };

      await expect(runAuditionStage(input, stale)).rejects.toThrow(/changed since this stage was keyed/);
    } finally {
      db.close();
    }
  });

  it("one-stage runs with two profiles are two cached runs", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeAuditionModel(), fakeRender());
    const facts = factsFile();
    await runVideo({ from: "audition", to: "audition", facts: facts.file, profile: "pr-overview" }, host);

    const pr = await runOneStage({ stage: "audition", inputs: { facts: facts.sha }, profile: "pr-overview" }, host);
    const tour = await runOneStage({ stage: "audition", inputs: { facts: facts.sha }, profile: "repo-tour" }, host);

    expect(pr.cached).toBe(true);
    expect(tour.cached).toBeFalsy();
    expect(tour.outputs["material-map"]).not.toBe(pr.outputs["material-map"]);
  });
});

/** Synthetic repo facts: a pending decision, one central problem and three parallel lints; no real repo is quoted. */
const REPO_FACTS = [
  "# Facts", "", "| Id | Claim |", "|---|---|",
  "| F1 | The owner should adopt the new cache. |", "| F2 | Builds are slow on every laptop. |",
  "| F3 | One lint flags long labels. |", "| F4 | One lint flags dark text. |", "| F5 | One lint flags clipped arrows. |", "",
].join("\n");

const auditionOf = (sha: string) => JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", sha), "utf8"));

async function audition(profile: string, facts: string, extra: Parameters<typeof fakeHost>[3] = {}, model = fakeAuditionModel()) {
  const file = path.join(fx.dataDir, "facts.md");
  writeFileSync(file, facts);
  const result = await runVideo({ from: "audition", to: "audition", facts: file, profile }, fakeHost(fx, model, fakeRender(), extra));
  const row = result.report.rows.find((r) => r.stage === "audition")!;
  return { result, row, model, record: row.outputs.audition ? auditionOf(row.outputs.audition) : undefined };
}

describe("audition sampling, scoring and pick", () => {
  it("samples k spines under different structures with stated likelihoods, scores each, and picks with a margin and runner-up", async () => {
    fx = fixture();

    const { result, row, record, model } = await audition("repo-argument", REPO_FACTS);

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(1);
    expect(record).toMatchObject({ schema: "audition/v1", k: 3, storyboardOnly: true, fallback: null, materialMap: row.outputs["material-map"] });
    expect(record.candidates.map((c: { structure: string; likelihood: number }) => [c.structure, c.likelihood])).toEqual([["scqa", 0.5], ["abt", 0.4], ["countdown", 0.3]]);
    for (const c of record.candidates) expect(Object.keys(c.scores)).toEqual(["fit", "coverage", "tension", "range", "freshness", "total"]);
    const totals = record.candidates.map((c: { id: string; scores: { total: number } }) => [c.id, c.scores.total]).sort((a: [string, number], b: [string, number]) => b[1] - a[1]);
    expect(record.pick.candidate).toBe(totals[0][0]);
    expect(record.runnerUp.candidate).toBe(totals[1][0]);
    expect(record.margin).toBeCloseTo(totals[0][1] - totals[1][1], 3);
  });

  it("writes the pick's chapter to profile block mapping and skips J12 on every storyboard", async () => {
    fx = fixture();

    const { result, record } = await audition("repo-argument", REPO_FACTS);

    const pick = record.candidates.find((c: { id: string }) => c.id === record.pick.candidate);
    expect(record.pick.chapters).toEqual(pick.spine.blocks.map((b: { id: string }) => ({ chapter: b.id, block: b.id })));
    for (const c of record.candidates) {
      expect(c.skipped.map((s: { dim: string }) => s.dim)).toEqual(["J12"]);
      expect(c.rubric.dims.map((d: { dim: string }) => d.dim)).toEqual(["J8", "J9", "J10", "J11"]);
    }
    expect(readFileSync(result.reportPath, "utf8")).toContain("J12 skipped: the storyboard shows a quotable visual on 1 beat");
    expect(record.rules).toMatchObject({ coverage: expect.stringMatching(/covers tags are not scored/), reHook: expect.stringMatching(/own band/) });
  });

  it("scores every candidate on the cold-viewer rubric, reported beside the pick", async () => {
    fx = fixture();

    const { row, record } = await audition("repo-argument", REPO_FACTS);

    expect(record.candidates.every((c: { rubric: { mode: string } | null }) => c.rubric?.mode === "reported")).toBe(true);
    expect(row).toMatchObject({ calls: 4, usd: 0.13 });
  });

  it("names the pick and the runner-up in the stage notes, with no owner gate", async () => {
    fx = fixture();

    const { result, record } = await audition("repo-argument", REPO_FACTS);

    const note = `audition pick: ${record.pick.candidate} ${record.pick.structure}`;
    expect(readFileSync(result.reportPath, "utf8")).toContain(note);
    expect(readFileSync(result.reportPath, "utf8")).toMatch(new RegExp(`runner-up: ${record.runnerUp.candidate} ${record.runnerUp.structure}`));
  });

  it("0 candidates fall back to the profile's fixed order, sample it under k beat systems, and record why", async () => {
    fx = fixture();

    const { result, record } = await audition("repo-tour", REPO_FACTS);

    expect(result.status, result.error).toBe("completed");
    expect(record.fallback).toMatchObject({ structure: "scqa-c4", reason: expect.stringMatching(/^0 candidates: scqa-c4 does not fit/) });
    expect(record.candidates.map((c: { system: string; basis: string }) => `${c.system}/${c.basis}`)).toEqual(["martini-glass/fallback", "chapter-question/fallback", "lab-cycle/fallback"]);
    expect(record.rules.fallback).toMatch(/fixed macro/);
  });

  it("an invalid sampling reply is retried once with its issues", async () => {
    fx = fixture();

    const { result, row, model } = await audition("repo-argument", REPO_FACTS, {}, fakeAuditionModel({ invalid: 1 }));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts[1]).toContain("unknown fact ids F999");
    expect(row).toMatchObject({ retries: 1, calls: 5 });
  });

  it("two invalid replies fail the stage with their spend recorded, and nothing is adopted", async () => {
    fx = fixture();

    const { result, row } = await audition("repo-argument", REPO_FACTS, {}, fakeAuditionModel({ invalid: 2 }));

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/rejected twice/);
    expect(row).toMatchObject({ calls: 2, usd: 0.2 });
    expect(row.outputs.audition).toBeUndefined();
  });

  it("a judge that cannot score leaves the rubric null and the code pick stands", async () => {
    fx = fixture();

    const { result, record } = await audition("repo-argument", REPO_FACTS, { rubric: { harness: throwingRubric, calls: [] } });

    expect(result.status, result.error).toBe("completed");
    expect(record.candidates.map((c: { rubric: unknown }) => c.rubric)).toEqual([null, null, null]);
    expect(record.rubricError).toBe("spawn failed");
    expect(record.pick.candidate).toMatch(/^c[123]$/);
  });
});
