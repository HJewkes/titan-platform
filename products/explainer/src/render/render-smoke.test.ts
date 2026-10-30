import { mkdtempSync } from "node:fs";
import path from "node:path";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadQaGate } from "../qa/gate-profile.js";
import { fakeQa } from "../qa/qa-fakes.test-helpers.js";
import { ArtifactStore } from "../workflow/artifacts.js";
import { openState } from "../workflow/host.js";
import { cloneFixture, dropSeeds, fakeRender, LAX_TIMING, seededRun, type Fixture } from "../workflow/run-fakes.test-helpers.js";
import type { FakeRenderOptions } from "./render-fakes.test-helpers.js";
import { SYNTHETIC_ANCHORS, writeSyntheticTree } from "./custom-layer-fixture.test-helpers.js";
import { renderSmoke, runArtifacts, SMOKE_WORKERS } from "./render-smoke.js";

let fx: Fixture;
afterEach(() => fx.cleanup());
afterAll(dropSeeds);

const HELD = { qa: { findingsAt: () => [{ kind: "text-overlap" as const, el: "h2", text: "a", other: "b", at: { x: 0, y: 0, w: 9, h: 9 } }] } };

/** The run's artifacts with its first beat turned custom and a custom-layers tree holding that beat's layer, as resolve and layer-build leave a run. */
function withCustomLayer(artifacts: Record<string, string>, store: ArtifactStore, dir: string): Record<string, string> {
  const resolved = JSON.parse(store.readText(artifacts.resolved!)) as { beats: { id: string }[] };
  const first = resolved.beats[0]!;
  const from = { runId: "input", stage: "input" };
  const custom = { ...resolved, beats: [{ ...first, layer: "custom", anchors: SYNTHETIC_ANCHORS }, ...resolved.beats.slice(1)] };
  const tree = writeSyntheticTree(mkdtempSync(path.join(dir, "tree-")), first.id);
  return { ...artifacts, resolved: store.putText(JSON.stringify(custom), "resolved", from), "custom-layers": store.putTree(tree, "custom-layers", from) };
}

/** A copy of the file's fake run stored to `to`, then the smoke over it with the render engine `options` give. */
async function smokeOf(to: "resolve" | "tts", options: FakeRenderOptions = {}, withCustomBeat = false) {
  const seed = await seededRun({ to });
  const { runId } = seed.result;
  fx = cloneFixture(seed);
  const db = openState(fx.dataDir);
  try {
    const store = new ArtifactStore(fx.dataDir, db);
    const stored = runArtifacts(new WorkflowRunStore(db).get(runId)!);
    const artifacts = withCustomBeat ? withCustomLayer(stored, store, fx.dataDir) : stored;
    const input = { runId, artifacts, store, gate: loadQaGate(undefined), qa: fakeQa(options.qa), timing: LAX_TIMING, workers: SMOKE_WORKERS, keepDir: path.join(fx.dataDir, "smoke") };
    const render = fakeRender(options);
    return { runId, render, result: await renderSmoke(input, render.engine(fx)) };
  } finally {
    db.close();
  }
}

describe("the real-run render smoke", () => {
  it("refuses a run that stopped before tts, naming the artifacts it lacks", async () => {
    const smoke = smokeOf("resolve");

    await expect(smoke).rejects.toThrow(/has no "words", "audio" artifact/);
  });

  it("passes two QA-gated renders at 16 workers with the same MP4 bytes", async () => {
    const { render, result } = await smokeOf("tts");

    expect(render.renders.map((r) => r.workers)).toEqual([16, 16]);
    expect(result).toMatchObject({ pass: true, qaGate: "passed", heldErrors: 0 });
    expect(result.mp4s[0]).toBe(result.mp4s[1]);
  });

  it("fails when the second render's MP4 differs from the first", async () => {
    const { result } = await smokeOf("tts", { varies: true });

    expect(result.pass).toBe(false);
    expect(result.mp4s[0]).not.toBe(result.mp4s[1]);
  });

  it("fails on held QA errors, reporting each row's kind and beat, and renders no second time", async () => {
    const { render, result } = await smokeOf("tts", HELD);

    expect(result).toMatchObject({ pass: false, qaGate: "refused", mp4s: [] });
    expect(result.heldErrors).toBeGreaterThan(0);
    expect(result.held[0]).toMatchObject({ kind: "text-overlap", beat: expect.stringMatching(/^beat-\d\d$/) });
    expect(render.renders).toHaveLength(1);
  });

  // Mutation: OPTIONAL leaves "custom-layers" out, so the render stage never sees the run's tree.
  it("draws a custom beat's layer from the run's custom-layers artifact", async () => {
    const { result } = await smokeOf("tts", {}, true);

    expect(result).toMatchObject({ pass: true, qaGate: "passed" });
  });
});
