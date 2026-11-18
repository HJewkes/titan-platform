import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptSchema } from "../script-schema.js";
import { runVideo, type RunOutcome } from "../workflow/host.js";
import { fakeHost, fakeRender, fakeScriptModel, fixture, type Fixture } from "../workflow/run-fakes.test-helpers.js";
import { RenderManifestSchema, type RenderManifest } from "./render-manifest.js";

let fx: Fixture;
let run: RunOutcome;
let manifest: RenderManifest;

const artifact = (sha: string): string => readFileSync(path.join(fx.dataDir, "artifacts", sha), "utf8");
const outputOf = (stage: string, name: string): string => run.report.rows.find((row) => row.stage === stage)!.outputs[name]!;

/** One fake run to render on the synthetic fixture; the host's clock ticks one second a read. */
beforeAll(async () => {
  fx = fixture();
  run = await runVideo({ spine: fx.spine, facts: fx.facts, to: "render" }, fakeHost(fx, fakeScriptModel(), fakeRender()));
  if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
  manifest = RenderManifestSchema.parse(JSON.parse(artifact(outputOf("render", "render-manifest"))));
});
afterAll(() => fx.cleanup());

describe("the render stage's manifest sidecars", () => {
  // Mutation: a chapter's end is its last beat's end instead of the next chapter's start.
  it("writes the script's chapters tiling the video, each ending where the next opens", () => {
    const script = ScriptSchema.parse(JSON.parse(artifact(outputOf("rewrite", "script"))));
    const chapters = manifest.chapters!;

    expect(chapters.map((c) => c.id)).toEqual(script.chapters.map((c) => c.id));
    expect(chapters[0]!.startS).toBe(0);
    for (const [i, chapter] of chapters.slice(1).entries()) expect(chapter.startS).toBe(chapters[i]!.endS);
    expect(chapters.at(-1)!.endS).toBeCloseTo(manifest.durationS, 3);
  });

  it("copies tts's voice block from voice.json", () => {
    const voice = JSON.parse(artifact(outputOf("tts", "voice")));

    expect(manifest.voice).toEqual({ provider: voice.provider, engine: voice.engine, id: voice.id, rate: voice.rate, source: voice.source });
  });

  it("lists each earlier stage's StepUsage from its run record, then render's own", () => {
    const earlier = run.report.rows.filter((row) => row.status !== "not run" && row.stage !== "render");

    expect(manifest.steps!.map((step) => step.stage)).toEqual([...earlier.map((row) => row.stage), "render"]);
    for (const row of earlier) {
      expect(manifest.steps!.find((step) => step.stage === row.stage)).toMatchObject({ wallS: row.wallMs / 1000, usd: row.usd, inputTokens: row.inputTokens, calls: row.calls });
    }
    expect(manifest.steps!.find((step) => step.stage === "script")!.usd).toBeGreaterThan(0);
  });

  it("times render's own row on the injected clock, with no model spend", () => {
    const own = manifest.steps!.at(-1)!;

    expect(own).toEqual({ stage: "render", wallS: 1, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 });
  });
});
