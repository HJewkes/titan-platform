import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { serveRoundMedia, type RoundMediaKind } from "./round-clip.js";
import { closedPort, syntheticMp4 } from "./test-support.js";

const ROUND = "ember-motion-r1";
const CLIP = syntheticMp4();
/** A RIFF header and a few silent samples: enough bytes to slice, no real recording. */
const SOUND = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"), Buffer.alloc(64)]);
const notes = { changed: "The ember glows before it fades.", context: "Colour is out of scope." };

let root: string;
let dir: string;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "console-round-clip-")));
  dir = path.join(root, "rounds");
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(root, { recursive: true, force: true });
});

const BLIND_AB = { id: "listen", kind: "blind-ab", prompt: "Which take reads better?", pairs: [{ id: "line-1", transcript: "Welcome back.", takes: [{ engine: "engine-alpha", src: "sounds/chime.wav" }, { engine: "engine-beta", src: "sounds/other.wav" }] }] };

function roundJson(clip: string, blind = false): unknown {
  const questionIds = blind ? ["fade-pick", "listen"] : ["fade-pick"];
  return {
    schema: "titan-review/round@2",
    unit: "ember-motion",
    round: 1,
    storybookUrl: "http://127.0.0.1:6006",
    widths: [390],
    variants: [
      { key: "ember", clip, label: "Ember fade", motion: { mechanism: "clip", keyframes: [{ atMs: 500, label: "glow" }] } },
      { key: "lamp", image: "shots/lamp.png", label: "Lamp" },
      { key: "chime", audio: "sounds/chime.wav", transcript: "The kettle is ready.", label: "Chime" },
    ],
    sections: [{ id: "fade", title: "Ember fade", deciding: "How the ember fades.", ...notes, kind: "STATES", parts: [{ id: "ember-fade", label: "Ember fade", proposed: "fade: 500ms" }], variantKeys: ["ember", "lamp", "chime"], questionIds }],
    questions: [{ id: "fade-pick", kind: "pick-one", prompt: "Does the fade read?", options: ["yes", "no"], signsOff: "ember-fade" }, ...(blind ? [BLIND_AB] : [])],
  };
}

async function put(file: string, body: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

/** A round whose `ember` variant declares a clip and `chime` a sound, with both written as the round names them. */
async function stage(clip = "clips/ember.mp4", blind = false): Promise<string> {
  const roundDir = path.join(dir, ROUND);
  await put(path.join(roundDir, "round.json"), JSON.stringify(roundJson(clip, blind)));
  await put(path.join(roundDir, "clips", "ember.mp4"), CLIP);
  await put(path.join(roundDir, "sounds", "chime.wav"), SOUND);
  return roundDir;
}

const get = (key: string, range?: string, id = ROUND, kind: RoundMediaKind = "clip"): Promise<Response> =>
  serveRoundMedia(new Request(`http://127.0.0.1/media/rounds/${id}/${kind}/${key}`, range === undefined ? {} : { headers: { range } }), { dir }, id, key, kind);
const listen = (key: string, range?: string): Promise<Response> => get(key, range, ROUND, "audio");

async function expectRefused(response: Promise<Response>): Promise<void> {
  const answer = await response;
  expect(answer.status).toBe(404);
  expect(await answer.text()).toBe("Round media not found");
}

describe("rounds.clip answers byte ranges", () => {
  it("answers a range with 206, Accept-Ranges and the slice's Content-Range", async () => {
    await stage();

    const response = await get("ember", "bytes=0-9");

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(`bytes 0-9/${CLIP.length}`);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CLIP.subarray(0, 10));
  });

  it("answers no range with the whole clip", async () => {
    await stage();

    const response = await get("ember");

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CLIP);
  });

  it("answers a range past the end with 416 and the clip's size", async () => {
    await stage();

    const response = await get("ember", `bytes=${CLIP.length}-`);

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${CLIP.length}`);
  });
});

describe("rounds.clip serves only what the round declares, inside the round", () => {
  it("refuses a variant that declares no clip, and a key the round does not have", async () => {
    await stage();
    await put(path.join(dir, ROUND, "shots", "lamp.png"), "not a clip");

    await expectRefused(get("lamp"));
    await expectRefused(get("ghost"));
  });

  it("refuses a clip reached through a symlinked directory that leads out of the round", async () => {
    const roundDir = await stage();
    await rm(path.join(roundDir, "clips"), { recursive: true });
    await put(path.join(root, "outside", "ember.mp4"), CLIP);
    await symlink(path.join(root, "outside"), path.join(roundDir, "clips"));

    await expectRefused(get("ember", "bytes=0-9"));
  });

  it("refuses a clip that is itself a symlink", async () => {
    const roundDir = await stage();
    await rm(path.join(roundDir, "clips", "ember.mp4"));
    await put(path.join(root, "outside.mp4"), CLIP);
    await symlink(path.join(root, "outside.mp4"), path.join(roundDir, "clips", "ember.mp4"));

    await expectRefused(get("ember"));
  });

  it("refuses a clip path with a .. segment, which leaves the round invalid", async () => {
    await stage("../outside.mp4");
    await put(path.join(dir, "outside.mp4"), CLIP);

    await expectRefused(get("ember"));
  });

  it("refuses a FIFO at the clip's path without hanging", async () => {
    const roundDir = await stage();
    await rm(path.join(roundDir, "clips", "ember.mp4"));
    execFileSync("mkfifo", [path.join(roundDir, "clips", "ember.mp4")]);

    await expectRefused(get("ember"));
  });

  it("refuses an unsafe round id", async () => {
    await stage();

    await expectRefused(get("ember", undefined, ".."));
  });
});

async function startConsole(): Promise<string> {
  await put(path.join(root, "index.html"), "<!doctype html><title>console shell</title>");
  const config: ConsoleConfig = {
    port: 0,
    stateDir: path.join(root, "state"),
    activeWorkPort: await closedPort(),
    agentChatPort: await closedPort(),
    factoryPort: await closedPort(),
    agentChatTokenPath: path.join(root, "ui.token"),
    agentChatEventsDbPath: path.join(root, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(root, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(root, "state", "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(root, "state", "inbox"),
    roundsDir: dir,
    decisionsFile: null,
    videoRoots: [],
  };
  // The built app is served too, so a media route mounted behind its `/*` would answer with the page.
  handle = await startConsoleDaemon({ config, staticRoot: path.join(root, "index.html"), logger: silentLogger });
  return `http://127.0.0.1:${handle.port}`;
}

describe("rounds.audio serves an audio variant's sound", () => {
  it("answers a range with 206 and the sound's type", async () => {
    await stage();

    const response = await listen("chime", "bytes=0-3");

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(`bytes 0-3/${SOUND.length}`);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await response.arrayBuffer()).toString("latin1")).toBe("RIFF");
  });

  it("answers a range past the end with 416", async () => {
    await stage();

    expect((await listen("chime", `bytes=${SOUND.length + 5}-`)).status).toBe(416);
  });

  it("serves neither kind under the other's route", async () => {
    await stage();

    await expectRefused(listen("ember"));
    await expectRefused(get("chime"));
  });

  it("refuses a sound reached through a symlinked directory", async () => {
    const roundDir = await stage();
    await rm(path.join(roundDir, "sounds"), { recursive: true });
    await put(path.join(root, "outside", "chime.wav"), SOUND);
    await symlink(path.join(root, "outside"), path.join(roundDir, "sounds"));

    await expectRefused(listen("chime"));
  });

  it("serves nothing from a blind-ab round, not even a variant's own sound that a take shares", async () => {
    await stage("clips/ember.mp4", true);

    await expectRefused(listen("chime"));
  });
});

describe("the console daemon", () => {
  it("mounts rounds.clip and rounds.audio ahead of the built app", async () => {
    await stage();
    const origin = await startConsole();

    const clip = await fetch(`${origin}/media/rounds/${ROUND}/clip/ember`, { headers: { range: "bytes=0-1" } });
    const sound = await fetch(`${origin}/media/rounds/${ROUND}/audio/chime`, { headers: { range: "bytes=0-1" } });

    expect([clip.status, clip.headers.get("content-range")]).toEqual([206, `bytes 0-1/${CLIP.length}`]);
    expect([sound.status, sound.headers.get("content-range")]).toEqual([206, `bytes 0-1/${SOUND.length}`]);
  });
});
