import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConsoleSidecarSchema } from "../video-meta-mirror.test-helpers.js";
import { ArtifactStore } from "./artifacts.js";
import { BridgeFileSchema } from "./bridge.js";
import { openState, runOneStage, runVideo } from "./host.js";
import { fakeRender, fakeHost, fakeMedia, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";
import { ffmpegMedia } from "./sheets-stage.js";

let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

const row = (outcome: Awaited<ReturnType<typeof runVideo>>, stage: string) => outcome.report.rows.find((r) => r.stage === stage)!;
const artifact = (sha: string): string => readFileSync(path.join(fx!.dataDir, "artifacts", sha), "utf8");
const sidecarOf = (sha: string) => ConsoleSidecarSchema.parse(JSON.parse(artifact(sha)));
const FingerprintShape = z.object({ schema: z.string(), beats: z.array(z.object({ id: z.string(), layoutKey: z.string(), pixel: z.null() })) });

/** The fixture's bridge with the theater also taking the sidecar and the poster, as a host bridge does. */
function linkSidecarIntoTheater(fixture: Fixture): void {
  const file = path.join(fixture.dataDir, "bridge.json");
  const bridge = BridgeFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const files = { ...bridge.theater.files, sidecar: ".video.json", poster: "-poster.jpg" };
  writeFileSync(file, JSON.stringify({ ...bridge, theater: { ...bridge.theater, files } }));
}

async function firstRun(fixture: Fixture) {
  const media = fakeMedia();
  const result = await runVideo({ spine: fixture.spine, facts: fixture.facts }, fakeHost(fixture, fakeScriptModel(), fakeRender(), { media }));
  return { result, media };
}

describe("the sheets stage in a run", () => {
  it("writes the sidecar, the poster and the fingerprint, and export links the first two into the theater", async () => {
    fx = fixture();
    linkSidecarIntoTheater(fx);

    const { result, media } = await firstRun(fx);

    expect(result.status, result.error).toBe("completed");
    const { sidecar, poster, fingerprint } = row(result, "sheets").outputs;
    expect(Object.keys(row(result, "sheets").outputs).sort()).toEqual(["fingerprint", "poster", "sidecar"]);
    expect(media.frames).toEqual([60]);
    expect(sidecarOf(sidecar!)).toMatchObject({ posterAtS: 60, poster: "demo-poster.jpg", explainer: { videoId: result.runId, runIds: [result.runId], scriptSha: row(result, "rewrite").outputs.script } });
    expect(FingerprintShape.parse(JSON.parse(artifact(fingerprint!))).beats.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(fx.theater, "demo.video.json"), "utf8")).toBe(artifact(sidecar!));
    expect(readFileSync(path.join(fx.theater, "demo-poster.jpg"), "utf8")).toBe(artifact(poster!));
  });

  it("lists both runs of a video in a repair run's sidecar, oldest first", async () => {
    fx = fixture();
    const { result: first } = await firstRun(fx);

    const repair = await runVideo({ from: "sheets", base: first.runId }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(repair.status, repair.error).toBe("completed");
    expect(sidecarOf(row(repair, "sheets").outputs.sidecar!).explainer).toMatchObject({ videoId: first.runId, runIds: [first.runId, repair.runId] });
  });
});

describe("explainer stage sheets", () => {
  it("lists the runs of the video it names, hits the cache on the same runs and misses it once the video has a new run", async () => {
    fx = fixture();
    const { result: first } = await firstRun(fx);
    const host = fakeHost(fx, fakeScriptModel(), fakeRender());
    const inputs = { mp4: row(first, "render").outputs.mp4!, script: row(first, "rewrite").outputs.script! };

    const once = await runOneStage({ stage: "sheets", inputs, video: first.runId }, host);
    const again = await runOneStage({ stage: "sheets", inputs, video: first.runId }, host);
    const repair = await runVideo({ from: "sheets", base: first.runId }, host);
    const after = await runOneStage({ stage: "sheets", inputs, video: first.runId }, host);

    expect(sidecarOf(once.outputs.sidecar!).explainer?.runIds).toEqual([first.runId]);
    expect(again.cached).toBe(true);
    expect(after.cached).toBeFalsy();
    expect(sidecarOf(after.outputs.sidecar!).explainer?.runIds).toEqual([first.runId, repair.runId]);
  });

  it("makes the child run the video's only run when no video is named", async () => {
    fx = fixture();
    const { result: first } = await firstRun(fx);
    const inputs = { mp4: row(first, "render").outputs.mp4!, script: row(first, "rewrite").outputs.script! };

    const record = await runOneStage({ stage: "sheets", inputs }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(sidecarOf(record.outputs.sidecar!).explainer).toMatchObject({ videoId: record.childRunId, runIds: [record.childRunId] });
  });

  it("refuses a video no run belongs to", async () => {
    fx = fixture();
    const { result: first } = await firstRun(fx);
    const inputs = { mp4: row(first, "render").outputs.mp4!, script: row(first, "rewrite").outputs.script! };

    const run = runOneStage({ stage: "sheets", inputs, video: "no-such-video" }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    await expect(run).rejects.toThrow("no explainer-video run belongs to video no-such-video");
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("the sheets stage on a real video", () => {
  it("probes an ffmpeg-made video and grabs a 480 px poster 30 % in", async () => {
    fx = fixture();
    const { result: first } = await firstRun(fx);
    const mp4File = path.join(path.join(fx.dataDir, ".."), "synthetic.mp4");
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=10", "-pix_fmt", "yuv420p", mp4File]);
    expect(made.status, made.stderr.toString()).toBe(0);
    const db = openState(fx.dataDir);
    const mp4 = new ArtifactStore(fx.dataDir, db).putFile(mp4File, "mp4", { runId: "input", stage: "input" });
    db.close();

    const record = await runOneStage({ stage: "sheets", inputs: { mp4, script: row(first, "rewrite").outputs.script! } }, fakeHost(fx, fakeScriptModel(), fakeRender(), { media: ffmpegMedia() }));

    expect(sidecarOf(record.outputs.sidecar!).posterAtS).toBe(1.2);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width", "-of", "csv=p=0", path.join(fx.dataDir, "artifacts", record.outputs.poster!)]);
    expect(probe.stdout.toString().trim()).toBe("mjpeg,480");
  });
});
