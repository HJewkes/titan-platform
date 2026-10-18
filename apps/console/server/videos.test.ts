import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "./commands.js";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { closedPort } from "./test-support.js";
import { ROOTS_UNSET, scanVideos, videoCatalog, videoId, videosCommands } from "./videos.js";

/** An `ftyp` box and padding: enough to look like an mp4, never a real render. */
const SYNTHETIC_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(52, 0x2e)]);
const SYNTHETIC_VTT = "WEBVTT\n\n00:00.000 --> 00:01.000\nA lantern flickers\n\n00:01.000 --> 00:02.000\nThe kettle sings\n";

let dir: string;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "console-videos-")));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function put(file: string, body: string | Buffer = SYNTHETIC_MP4): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

async function startWithRoots(roots: string[]): Promise<string> {
  const page = await put(path.join(dir, "index.html"), "<!doctype html><title>console shell</title>");
  const config: ConsoleConfig = {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: await closedPort(),
    agentChatPort: await closedPort(),
    factoryPort: await closedPort(),
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(dir, "state", "inbox"),
    roundsDir: path.join(dir, "state", "rounds"),
    decisionsFile: null,
    videoRoots: roots,
  };
  // The built app is served too, so a media route mounted behind its `/*` would answer 404.
  handle = await startConsoleDaemon({ config, staticRoot: page, logger: silentLogger });
  return `http://127.0.0.1:${handle.port}`;
}

describe("the video catalog", () => {
  it("lists only videos outside dot-dirs, node_modules and archive, grouped by their directory under the root", async () => {
    const first = path.join(dir, "first");
    const second = path.join(dir, "second");
    await put(path.join(first, "orbit", "render", "cut.mp4"));
    await put(path.join(first, "orbit", "render", "cut.vtt"), SYNTHETIC_VTT);
    await put(path.join(first, "orbit", "render", "render-notes.md"), "# notes");
    await put(path.join(first, ".cache", "stray.mp4"));
    await put(path.join(first, "node_modules", "pkg", "demo.webm"));
    await put(path.join(second, "kiln", "archive", "old.mp4"));
    await put(path.join(second, "kiln", "notes.txt"), "not a video");

    const { videos, truncated, gaps } = await scanVideos([first, second]);

    expect({ truncated, gaps }).toEqual({ truncated: false, gaps: [] });
    expect(videos).toEqual([
      expect.objectContaining({ id: videoId(first, path.join("orbit", "render", "cut.mp4")), title: "cut", group: "first/orbit/render", bytes: SYNTHETIC_MP4.length, captions: true, renderNotes: true }),
    ]);
  });

  it("leaves out a symlink that leads outside its root", async () => {
    const root = path.join(dir, "root");
    const outside = await put(path.join(dir, "outside", "secret.mp4"));
    await mkdir(root);
    await symlink(outside, path.join(root, "escape.mp4"));

    const { videos } = await scanVideos([root]);

    expect(videos).toEqual([]);
  });

  it("answers an empty list and one gap line when no roots are set", async () => {
    expect(await scanVideos([])).toMatchObject({ videos: [], truncated: false, gaps: [ROOTS_UNSET] });
    expect(await videosCommands(undefined)["videos.list"].run({}, {} as never)).toEqual({ videos: [], truncated: false, gaps: [ROOTS_UNSET] });
  });

  it("reports an unreadable root as a gap that names no path", async () => {
    const { gaps } = await scanVideos([path.join(dir, "missing")]);
    expect(gaps).toEqual(["Video root 1 of 1 cannot be read"]);
  });

  it("serves the cached scan for 30 s, then rescans", async () => {
    let now = 0;
    const root = path.join(dir, "root");
    await put(path.join(root, "a.mp4"));
    const catalog = videoCatalog({ roots: [root], now: () => now });
    expect((await catalog.current()).videos).toHaveLength(1);
    await put(path.join(root, "b.mp4"));
    now = 29_999;
    expect((await catalog.current()).videos).toHaveLength(1);
    now = 30_000;
    expect((await catalog.current()).videos).toHaveLength(2);
  });
});

describe("the media routes", () => {
  it("lists videos over /rpc and answers a byte range on /media/videos/:id with 206", async () => {
    const root = path.join(dir, "root");
    await put(path.join(root, "orbit", "cut.mp4"));
    const origin = await startWithRoots([root]);
    const { videos } = await createRpcClient<ConsoleCommands>(liveSource({ origin })).call("videos.list");

    const res = await fetch(`${origin}/media/videos/${videos[0]!.id}`, { headers: { range: "bytes=0-1" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${SYNTHETIC_MP4.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(SYNTHETIC_MP4.subarray(0, 2)));
  });

  it("serves the captions beside a video as text/vtt", async () => {
    const root = path.join(dir, "root");
    await put(path.join(root, "cut.webm"));
    await put(path.join(root, "cut.vtt"), SYNTHETIC_VTT);
    const origin = await startWithRoots([root]);

    const res = await fetch(`${origin}/media/videos/${videoId(root, "cut.webm")}/captions`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(await res.text()).toBe(SYNTHETIC_VTT);
  });

  it("answers a malformed or traversing id with fixed text that names no path", async () => {
    const origin = await startWithRoots([path.join(dir, "root")]);
    for (const id of ["v_zz", "..%2f..%2fetc%2fpasswd", `v_${"0".repeat(20)}`]) {
      const res = await fetch(`${origin}/media/videos/${id}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Video not found");
    }
  });

  it("answers 404 for the id of a symlink that leads outside its root", async () => {
    const root = path.join(dir, "root");
    await mkdir(root);
    await symlink(await put(path.join(dir, "outside", "secret.mp4")), path.join(root, "escape.mp4"));
    const origin = await startWithRoots([root]);

    const res = await fetch(`${origin}/media/videos/${videoId(root, "escape.mp4")}`);

    expect(res.status).toBe(404);
  });

  it("refuses a listed video swapped for a symlink out of its root since the scan", async () => {
    const root = path.join(dir, "root");
    const cut = await put(path.join(root, "orbit", "cut.mp4"));
    const outside = await put(path.join(dir, "outside", "secret.mp4"));
    const origin = await startWithRoots([root]);
    await createRpcClient<ConsoleCommands>(liveSource({ origin })).call("videos.list");
    await rm(cut);
    await symlink(outside, cut);

    const res = await fetch(`${origin}/media/videos/${videoId(root, path.join("orbit", "cut.mp4"))}`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Video not found");
  });
});
