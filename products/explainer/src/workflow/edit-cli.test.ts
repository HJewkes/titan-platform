import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import type { BeatWorker } from "../build/beat-worker.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { EDIT_BUDGET_USD, runEditCli, type DetachedSpawn, type EditCliDeps } from "./edit-cli.js";
import { readLedger } from "./edit-ledger.js";
import { openState, runVideo, type RunOutcome } from "./host.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { RunPlanSchema } from "./pipeline.js";
import type { RunReport } from "./report.js";
import { runRunCli } from "./run-cli.js";
import { fakeBridge, fakeHost, fakeScriptModel, fakeVoice, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run, render or note.
let fx: Fixture;
afterEach(() => fx.cleanup());

const out = (report: RunReport, stage: string) => report.rows.find((r) => r.stage === stage)!.outputs;
const figures = [{ id: "scan-rate", value: 4, label: "Scans a minute" }];

interface Base {
  result: RunOutcome;
  scriptSha: string;
  mp4Sha: string;
}

async function baseRun(extra: Parameters<typeof fakeHost>[3] = {}, model = fakeScriptModel()): Promise<Base> {
  const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge(), extra));
  return { result, scriptSha: out(result.report, "rewrite").script!, mp4Sha: out(result.report, "render").mp4! };
}

function editFile(base: Base, beats: Record<string, unknown>, name = "edit.json"): string {
  const file = path.join(fx.workdir, name);
  const edit = { schema: "explainer.slot-edit/v1", base: { runId: base.result.runId, scriptSha: base.scriptSha, mp4Sha: base.mp4Sha }, beats, createdAt: "2026-10-24T00:00:00Z" };
  writeFileSync(file, JSON.stringify(edit));
  return file;
}

async function cli(argv: string[], deps: EditCliDeps = {}): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await runEditCli(["edit", ...argv, "--data-dir", fx.dataDir], { out: (t) => lines.push(t), err: (t) => lines.push(t), ...deps });
  return { code, text: lines.join("") };
}

function recordingSpawn(): { spawn: DetachedSpawn; launched: (readonly string[])[] } {
  const launched: (readonly string[])[] = [];
  return { spawn: (argv) => launched.push(argv), launched };
}

/** Every file under the data dir with its size, and every run and artifact row: what a dry run must leave alone. */
function snapshot(): unknown {
  const files = readdirSync(fx.dataDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith("state.sqlite3"));
  const db = openState(fx.dataDir);
  try {
    const rows = db.prepare("SELECT (SELECT count(*) FROM explainer_artifacts) AS artifacts, (SELECT count(*) FROM workflow_run) AS runs").get();
    return { files: files.map((e) => path.join(e.parentPath, e.name)).sort(), rows };
  } finally {
    db.close();
  }
}

function planOf(runId: string) {
  const db = openState(fx.dataDir);
  try {
    return RunPlanSchema.parse(JSON.parse(new WorkflowRunStore(db).get(runId)!.params.plan!));
  } finally {
    db.close();
  }
}

/** Runs the launched argv in this process, as the detached `explainer run` would, on a voice that counts its takes. */
async function runLaunched(argv: readonly string[], extra: Parameters<typeof fakeHost>[3] = {}) {
  const voice = fakeVoice();
  const host = fakeHost(fx, fakeScriptModel(), fakeBridge(), { ttsEngine: voice.engine, ...extra });
  const code = await runRunCli([...argv], { host, out: () => {}, err: () => {} });
  return { code, voice };
}

describe("explainer edit check", () => {
  it("prints the diff per beat and field and leaves the store and the ledger as they were", async () => {
    fx = fixture();
    const base = await baseRun();
    const file = editFile(base, { h1: { slots: { figures } } });
    const before = snapshot();

    const { code, text } = await cli(["check", file]);

    expect(code).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ ok: true, problems: [], diff: [{ beat: "h1", path: "visual.slots.figures", after: figures }] });
    expect(snapshot()).toEqual(before);
  });

  it("refuses an override the beat's slot schema rejects, and adds the template fill's problems when a fill is given", async () => {
    fx = fixture();
    const base = await baseRun();
    const file = editFile(base, { h1: { slots: { figures: [{ ...figures[0], label: "x".repeat(49) }] } } });

    const { code, text } = await cli(["check", file], { fill: () => ["beats.h1: the filled slots miss figures.0.unit"] });

    expect(code).toBe(1);
    expect(JSON.parse(text).problems).toEqual([expect.stringMatching(/^beats\.h1\.visual\.slots\.figures\.0\.label: Too big/), "beats.h1: the filled slots miss figures.0.unit"]);
  });
});

describe("explainer edit apply", () => {
  it("stores the edited script and the ledger row, and launches nothing without --start", async () => {
    fx = fixture();
    const base = await baseRun();
    const { spawn, launched } = recordingSpawn();

    const { code, text } = await cli(["apply", editFile(base, { h1: { slots: { figures } } }), "--json"], { spawn });

    expect(code).toBe(0);
    const { editId, scriptSha, started } = JSON.parse(text);
    expect(started).toBe(false);
    expect(launched).toEqual([]);
    const stored = JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", scriptSha), "utf8"));
    expect(stored.beats[0].visual.slots).toEqual({ figures });
    expect(readLedger(fx.dataDir, editId)).toMatchObject({ base: { runId: base.result.runId, scriptSha: base.scriptSha }, scriptSha, status: "stored", videoId: base.result.runId });
  });

  it("with --start launches exactly the pinned resolve run, which links into the ledger, voices no take and sums with its base", async () => {
    fx = fixture();
    const base = await baseRun();
    const { spawn, launched } = recordingSpawn();

    const { editId, scriptSha } = JSON.parse((await cli(["apply", editFile(base, { h1: { slots: { figures } } }), "--start", "--json"], { spawn })).text);
    const { code, voice } = await runLaunched(launched[0]!);

    expect(launched).toEqual([["run", "--from", "resolve", "--base", base.result.runId, "--pin", `script=${scriptSha}`, "--edit", editId, "--budget-usd", String(EDIT_BUDGET_USD), "--data-dir", fx.dataDir]]);
    expect(code).toBe(0);
    const { runId } = readLedger(fx.dataDir, editId);
    expect(planOf(runId!)).toMatchObject({ from: "resolve", baseRunId: base.result.runId, videoId: base.result.runId, edit: editId, budgetUsd: EDIT_BUDGET_USD });
    expect(planOf(runId!).artifacts.script).toBe(scriptSha);
    expect(voice.spoken).toEqual([]);
    const report = JSON.parse(readFileSync(path.join(fx.dataDir, "runs", runId!, "run-report.json"), "utf8"));
    expect(out(report, "tts").words).toBe(out(base.result.report, "tts").words);
    expect(report).toMatchObject({ videoId: base.result.runId, linked: [{ runId: base.result.runId }], edit: { editId, beats: 1, baseRunId: base.result.runId } });
  });

  it("an edit run pins the base's custom layers and builds none", async () => {
    fx = fixture();
    const builds: string[] = [];
    const worker: BeatWorker = {
      builder: { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) },
      build: async ({ packet }) => (builds.push(packet.beat_id), { module: "export const Layer = () => null;\n", anchors: packet.anchors, elements: [], usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 1 } }),
    };
    const custom = { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", layer: "custom", anchors: ["B2:E5"] } };
    const base = await baseRun({ beatWorker: worker }, fakeScriptModel(choppy({ w1: custom })));
    const layers = out(base.result.report, "resolve")[CUSTOM_LAYERS];
    const { spawn, launched } = recordingSpawn();
    builds.length = 0;

    const { editId } = JSON.parse((await cli(["apply", editFile(base, { h1: { slots: { figures } } }), "--start", "--json"], { spawn })).text);
    const { code } = await runLaunched(launched[0]!, { beatWorker: worker });

    expect(layers).toBeDefined();
    expect(code).toBe(0);
    expect(planOf(readLedger(fx.dataDir, editId).runId!).artifacts[CUSTOM_LAYERS]).toBe(layers);
    expect(builds).toEqual([]);
  });
});

describe("explainer edit list", () => {
  it("lists a render's edits with each linked run's status", async () => {
    fx = fixture();
    const base = await baseRun();
    const { spawn, launched } = recordingSpawn();
    const ran = JSON.parse((await cli(["apply", editFile(base, { h1: { slots: { figures } } }), "--start", "--json"], { spawn })).text);
    await runLaunched(launched[0]!);
    const kept = JSON.parse((await cli(["apply", editFile(base, { h2: { tune: { stagger: 0.2 } } }, "kept.json"), "--json"])).text);

    const { code, text } = await cli(["list", "--mp4-sha", base.mp4Sha, "--json"]);

    expect(code).toBe(0);
    const rows = JSON.parse(text);
    expect(rows.map((r: { editId: string; runStatus: string }) => [r.editId, r.runStatus]).sort()).toEqual([[ran.editId, "completed"], [kept.editId, "not started"]].sort());
    expect(JSON.parse((await cli(["list", "--mp4-sha", "f".repeat(64), "--json"])).text)).toEqual([]);
  });
});
