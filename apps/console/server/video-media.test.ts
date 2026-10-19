import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticMp4, syntheticWebm } from "./test-support.js";
import { parseDoc, takeOf } from "./video-derived.js";
import { VIDEO_META_SCHEMA } from "./video-meta.js";
import { scanVideos } from "./videos.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "console-video-media-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relative: string, body: string | Buffer = syntheticMp4()): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

async function onlyVideo() {
  const { videos, gaps } = await scanVideos([root]);
  expect(videos).toHaveLength(1);
  return { video: videos[0]!, gaps };
}

const byStem = (videos: readonly { id: string; title: string }[]) => Object.fromEntries(videos.map((video) => [video.title, video]));

describe("media headers", () => {
  it("reads duration, size, orientation and sound from an mp4 whose moov follows its media", async () => {
    await put("orbit/cut.mp4", syntheticMp4({ durationS: 12.345, width: 1920, height: 1080, audio: true }));

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual([]);
    expect(video).toMatchObject({ durationS: 12.345, width: 1920, height: 1080, orientation: "landscape", audio: true });
  });

  it("swaps the size of a track turned a quarter and reads a silent mp4 as having no sound", async () => {
    await put("orbit/phone.mp4", syntheticMp4({ width: 1920, height: 1080, quarterTurn: true }));

    const { video } = await onlyVideo();

    expect(video).toMatchObject({ width: 1080, height: 1920, orientation: "portrait", audio: false });
  });

  it("reads the same fields from a webm's EBML head", async () => {
    await put("orbit/cut.webm", syntheticWebm({ durationS: 4.5, width: 720, height: 720, audio: true }));

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual([]);
    expect(video).toMatchObject({ durationS: 4.5, width: 720, height: 720, orientation: "square", audio: true });
  });

  it("leaves the duration unknown for a recorder webm that never wrote one", async () => {
    await put("orbit/live.webm", syntheticWebm({ durationS: null }));

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual([]);
    expect(video).toMatchObject({ durationS: null, width: 64, height: 36, audio: false });
  });

  it.each([
    ["a truncated mp4", "cut.mp4", syntheticMp4().subarray(0, syntheticMp4().length - 10)],
    ["an mp4 with no moov", "cut.mp4", syntheticMp4().subarray(0, 34)],
    ["bytes that are not an mp4", "cut.mp4", Buffer.from("not a video at all")],
    ["bytes that are not a webm", "cut.webm", Buffer.from("not a video at all")],
    ["an empty file", "cut.webm", Buffer.alloc(0)],
  ])("lists %s with unknown media fields and one gap line", async (_case, name, body) => {
    await put(`orbit/${name}`, body);

    const { video, gaps } = await onlyVideo();

    expect(gaps).toEqual(["1 video header could not be read"]);
    expect(video).toMatchObject({ durationS: null, width: null, height: null, orientation: null, audio: null });
  });

  it("re-reads headers only when the file's size or mtime changes", async () => {
    const file = await put("orbit/cut.mp4", syntheticMp4({ durationS: 2 }));
    // Whole seconds, because a Date cannot carry the sub-millisecond part of a real mtime back.
    const mtime = new Date(2026, 0, 1);
    await utimes(file, mtime, mtime);
    expect((await onlyVideo()).video.durationS).toBe(2);

    await writeFile(file, syntheticMp4({ durationS: 3 }));
    await utimes(file, mtime, mtime);
    expect((await onlyVideo()).video.durationS).toBe(2);

    const later = new Date(mtime.getTime() + 5000);
    await utimes(file, later, later);
    expect((await onlyVideo()).video.durationS).toBe(3);
  });
});

describe("copy folding", () => {
  it("folds identical files under copies and intermediate folders into the render they duplicate", async () => {
    await put("orbit/cut.mp4");
    await put("orbit/copies/cut.mp4");
    await put("orbit/intermediate/cut-pass1.mp4");

    const { video } = await onlyVideo();

    expect(video).toMatchObject({ group: expect.stringMatching(/\/orbit$/), copies: 2 });
  });

  it("keeps a same-size file in a copies folder whose bytes differ", async () => {
    await put("orbit/cut.mp4", syntheticMp4({ payload: "frames-a" }));
    await put("orbit/copies/cut.mp4", syntheticMp4({ payload: "frames-b" }));

    const { videos } = await scanVideos([root]);

    expect(videos.map((video) => video.copies)).toEqual([0, 0]);
  });

  it("never folds identical files outside copy folders", async () => {
    await put("orbit/a.mp4");
    await put("orbit/b.mp4");

    const { videos } = await scanVideos([root]);

    expect(videos).toHaveLength(2);
  });

  it("keeps one row when every identical file is a copy", async () => {
    await put("orbit/copies/one.mp4");
    await put("orbit/copies/two.mp4");

    const { video } = await onlyVideo();

    expect(video).toMatchObject({ title: "one", copies: 1 });
  });
});

describe("derived fields", () => {
  it("titles a render from its render notes before its brief, describing it with the first paragraph", async () => {
    await put("orbit/cut.mp4");
    await put("orbit/render-notes.md", "# Lantern walkthrough\n\nHow the lantern\nlights the kettle.\n\n## Beats\n");
    await put("orbit/BRIEF.md", "# Brief title\n");

    const { video } = await onlyVideo();

    expect(video).toMatchObject({ title: "Lantern walkthrough", description: "How the lantern lights the kettle." });
  });

  it("falls back to the brief's H1, then the file stem", async () => {
    await put("orbit/cut.mp4");
    await put("orbit/BRIEF.md", "Intro line\n# Kettle brief\n");
    await put("plain/other.mp4", syntheticMp4({ payload: "other" }));

    const { videos } = await scanVideos([root]);

    expect(videos.map((video) => video.title).sort()).toEqual(["Kettle brief", "other"]);
  });

  it("appends the take when siblings share a derived title, and marks the earlier take superseded", async () => {
    await put("orbit/lantern-v1.mp4", syntheticMp4({ payload: "take one" }));
    await put("orbit/lantern-v2.mp4", syntheticMp4({ payload: "take two" }));
    await put("orbit/render-notes.md", "# Lantern walkthrough\n");

    const titled = byStem((await scanVideos([root])).videos);

    expect(titled["Lantern walkthrough (v1)"]).toMatchObject({ series: "lantern", take: "v1", superseded: true });
    expect(titled["Lantern walkthrough (v2)"]).toMatchObject({ series: "lantern", take: "v2", superseded: false });
  });

  it("lets a sidecar value beat every derived one", async () => {
    await put("orbit/lantern-v1.mp4", syntheticMp4({ payload: "take one" }));
    await put("orbit/lantern-v1.video.json", JSON.stringify({ schema: VIDEO_META_SCHEMA, title: "Pinned", description: "Kept", series: "kept", take: "first", status: "final" }));
    await put("orbit/lantern-v2.mp4", syntheticMp4({ payload: "take two" }));
    await put("orbit/render-notes.md", "# Lantern walkthrough\n\nDerived description.\n");

    const titled = byStem((await scanVideos([root])).videos);

    expect(titled["Pinned"]).toMatchObject({ description: "Kept", series: "kept", take: "first", superseded: false });
    expect(titled["Lantern walkthrough"]).toMatchObject({ description: "Derived description.", take: "v2", superseded: false });
  });

  it("names a take only from a v or take suffix", () => {
    expect(takeOf("lantern-v2")).toEqual({ series: "lantern", take: "v2" });
    expect(takeOf("kettle_take-3")).toEqual({ series: "kettle", take: "take-3" });
    expect(takeOf("01-spin")).toBeNull();
    expect(takeOf("v2")).toBeNull();
  });

  it("reads no title from a doc without an H1", () => {
    expect(parseDoc("## Only a subheading\n\ntext")).toEqual({});
  });
});
