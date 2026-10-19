import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticMp4 } from "./test-support.js";
import { MAX_META_BYTES, VIDEO_FOLDER_SCHEMA, VIDEO_META_SCHEMA } from "./video-meta.js";
import { scanVideos } from "./videos.js";

const SYNTHETIC_MP4 = syntheticMp4();

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "console-video-meta-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relative: string, body: string | Buffer = SYNTHETIC_MP4): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

const json = (value: object) => JSON.stringify(value);

async function onlyVideo() {
  const { videos, gaps } = await scanVideos([root]);
  expect(videos).toHaveLength(1);
  return { video: videos[0]!, gaps };
}

describe("video sidecars", () => {
  it("lists a video with no sidecar with only the fields its file gives", async () => {
    await put("orbit/cut.mp4");

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual([]);
    expect(Object.keys(video).sort()).toEqual(
      ["audio", "bytes", "captions", "copies", "durationS", "group", "height", "id", "modifiedAt", "orientation", "renderNotes", "superseded", "title", "width"],
    );
    expect(video.title).toBe("cut");
  });

  it("reads every field of a valid sidecar onto the row", async () => {
    const meta = {
      title: "Lantern walkthrough, take 2",
      description: "How the lantern lights the kettle",
      purpose: "explainer",
      tags: ["lantern", "kettle"],
      subject: { kind: "repo", id: "lantern-kit" },
      posterAtS: 12.5,
      alias: "lantern-walkthrough",
      series: "lantern-walkthrough",
      take: "v2",
      status: "review",
    } as const;
    await put("orbit/cut.mp4");
    await put("orbit/cut.video.json", json({ schema: VIDEO_META_SCHEMA, ...meta }));

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual([]);
    expect(video).toMatchObject(meta);
    expect(video).not.toHaveProperty("schema");
  });

  it.each([
    ["an unknown field", json({ schema: VIDEO_META_SCHEMA, title: "Kettle", mood: "calm" })],
    ["a purpose outside the list", json({ schema: VIDEO_META_SCHEMA, purpose: "trailer" })],
    ["another schema", json({ schema: "titan-console/video-meta@2", title: "Kettle" })],
    ["text that is not JSON", "{ title: kettle"],
    ["a file over 64 KB", json({ schema: VIDEO_META_SCHEMA, title: "Kettle" }) + " ".repeat(MAX_META_BYTES)],
  ])("turns a sidecar with %s into one gap line and lists the video as if it had none", async (_case, body) => {
    await put("orbit/cut.mp4");
    await put("orbit/cut.video.json", body);

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual(["1 video sidecar could not be read"]);
    expect(video.title).toBe("cut");
    expect(video).not.toHaveProperty("purpose");
  });

  it("counts every bad sidecar in one plural gap line", async () => {
    for (const stem of ["a", "b"]) {
      await put(`orbit/${stem}.mp4`);
      await put(`orbit/${stem}.video.json`, "not json");
    }

    const { gaps } = await scanVideos([root]);

    expect(gaps).toEqual(["2 video sidecars could not be read"]);
  });

  it("re-reads a sidecar only when its size or mtime changes", async () => {
    await put("orbit/cut.mp4");
    const sidecar = await put("orbit/cut.video.json", json({ schema: VIDEO_META_SCHEMA, title: "Kettle A" }));
    // Whole seconds, because a Date cannot carry the sub-millisecond part of a real mtime back.
    const mtime = new Date(2026, 0, 1);
    await utimes(sidecar, mtime, mtime);
    expect((await onlyVideo()).video.title).toBe("Kettle A");

    await writeFile(sidecar, json({ schema: VIDEO_META_SCHEMA, title: "Kettle B" }));
    await utimes(sidecar, mtime, mtime);
    expect((await onlyVideo()).video.title).toBe("Kettle A");

    const later = new Date(mtime.getTime() + 5000);
    await utimes(sidecar, later, later);
    expect((await onlyVideo()).video.title).toBe("Kettle B");
  });
});

describe("folder manifests", () => {
  const manifest = {
    schema: VIDEO_FOLDER_SCHEMA,
    purpose: "clip",
    series: "motion-samples",
    parent: "lantern-walkthrough",
    items: { "01-spin.mp4": { title: "Spin", posterAtS: 1 } },
  };

  it("applies folder defaults to every video in the folder and an item to its own file", async () => {
    await put("clips/01-spin.mp4");
    await put("clips/02-fade.mp4");
    await put("clips/_videos.json", json(manifest));

    const { videos, gaps } = await scanVideos([root]);
    const byTitle = Object.fromEntries(videos.map((video) => [video.title, video]));

    expect(gaps).toEqual([]);
    expect(byTitle["Spin"]).toMatchObject({ purpose: "clip", series: "motion-samples", parent: "lantern-walkthrough", posterAtS: 1 });
    expect(byTitle["02-fade"]).toMatchObject({ purpose: "clip", series: "motion-samples" });
    expect(byTitle["02-fade"]).not.toHaveProperty("posterAtS");
  });

  it("leaves videos in other folders alone", async () => {
    await put("clips/_videos.json", json(manifest));
    await put("clips/inner/03-slide.mp4");

    const { video } = await onlyVideo();

    expect(video).not.toHaveProperty("purpose");
  });

  it("lets a sidecar field beat the manifest's item and default", async () => {
    await put("clips/01-spin.mp4");
    await put("clips/_videos.json", json(manifest));
    await put("clips/01-spin.video.json", json({ schema: VIDEO_META_SCHEMA, title: "Spin, final", purpose: "design" }));

    const { video } = await onlyVideo();

    expect(video).toMatchObject({ title: "Spin, final", purpose: "design", series: "motion-samples", posterAtS: 1 });
  });

  it("turns a bad manifest into one gap line and keeps the folder's sidecars", async () => {
    await put("clips/01-spin.mp4");
    await put("clips/_videos.json", json({ ...manifest, alias: "one-alias-for-a-whole-folder" }));
    await put("clips/01-spin.video.json", json({ schema: VIDEO_META_SCHEMA, purpose: "test" }));

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual(["1 video folder manifest could not be read"]);
    expect(video).toMatchObject({ title: "01-spin", purpose: "test" });
  });
});
