import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticMp4 } from "./test-support.js";
import { VIDEO_META_SCHEMA } from "./video-meta.js";
import { videoCatalog, videosCommands } from "./videos.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "console-resolve-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** `age` is seconds before a fixed base, so a larger age is an older file. */
async function put(relative: string, age: number, fields?: object): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, syntheticMp4({ payload: relative }));
  const time = new Date(1_800_000_000_000 - age * 1000);
  await utimes(file, time, time);
  if (fields !== undefined) await writeFile(file.replace(/\.mp4$/, ".video.json"), JSON.stringify({ schema: VIDEO_META_SCHEMA, ...fields }));
}

async function resolve(args: object) {
  const commands = videosCommands(videoCatalog({ roots: [root] }));
  const list = await commands["videos.list"].run({});
  const result = await commands["videos.resolve"].run(args as never);
  return { result, ids: Object.fromEntries(list.videos.map((video) => [video.title, video.id])) };
}

describe("videos.resolve", () => {
  it("returns the newest non-superseded take of a series", async () => {
    await put("a/lantern-v1.mp4", 300);
    await put("a/lantern-v2.mp4", 200);
    await put("a/kettle-v1.mp4", 10);

    const { result, ids } = await resolve({ series: "lantern" });

    expect(result).toEqual({ found: true, id: ids["lantern-v2"] });
  });

  it("skips a video the sidecar marks superseded even when it is the newest", async () => {
    await put("a/old.mp4", 300, { series: "s", tags: ["daily"] });
    await put("a/new.mp4", 10, { series: "s", tags: ["daily"], status: "superseded" });

    const { result, ids } = await resolve({ series: "s" });

    expect(result).toEqual({ found: true, id: ids["old"] });
  });

  it("matches by tag", async () => {
    await put("a/one.mp4", 100, { tags: ["red"] });
    await put("a/two.mp4", 50, { tags: ["blue", "red"] });
    await put("a/three.mp4", 10, { tags: ["blue"] });

    const { result, ids } = await resolve({ tag: "red" });

    expect(result).toEqual({ found: true, id: ids["two"] });
  });

  it("matches by subject id and combines filters", async () => {
    await put("a/one.mp4", 100, { series: "s", subject: { kind: "repo", id: "widgets" } });
    await put("a/two.mp4", 50, { series: "s", subject: { kind: "repo", id: "gadgets" } });

    expect((await resolve({ subject: "widgets" })).result).toMatchObject({ found: true });
    const { result, ids } = await resolve({ series: "s", subject: "widgets" });
    expect(result).toEqual({ found: true, id: ids["one"] });
  });

  it("looks an alias up, even on a superseded video", async () => {
    await put("a/one.mp4", 100, { alias: "kettle-demo", status: "superseded" });
    await put("a/two.mp4", 50);

    const { result, ids } = await resolve({ alias: "kettle-demo" });

    expect(result).toEqual({ found: true, id: ids["one"] });
  });

  it("says plainly when nothing matches", async () => {
    await put("a/one.mp4", 100, { series: "s" });

    expect((await resolve({ series: "nope" })).result).toMatchObject({ found: false, reason: expect.any(String) });
    expect((await resolve({ alias: "nope" })).result).toMatchObject({ found: false });
  });

  it("rejects a call with no filter, or an alias mixed with filters", async () => {
    const { args } = videosCommands(videoCatalog({ roots: [root] }))["videos.resolve"];

    expect(args.safeParse({}).success).toBe(false);
    expect(args.safeParse({ alias: "a", series: "s" }).success).toBe(false);
  });
});
