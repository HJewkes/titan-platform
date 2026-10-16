import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as NetModule from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { EXIT } from "@titan-design/registry";
import type { ConsoleConfig } from "./config.js";
import { createLoginLink, startConsoleDaemon } from "./daemon.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { MAX_FRAME_BYTES, frameIndex, getFrame } from "./round-frames.js";
import { closedPort, send, sessionCookie, writeSelfSignedCert, type Reply, type SelfSignedPair } from "./test-support.js";

// The LAN seam daemon.test.ts uses: 127.0.0.2 alone is let past the daemon's refusal of 127/8 as a remote host.
const LAN = vi.hoisted(() => "127.0.0.2");
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof NetModule>();
  class StandInBlockList extends actual.BlockList {
    override check(address: string | NetModule.SocketAddress, type?: NetModule.IPVersion): boolean {
      if (address === LAN) return false;
      return typeof address === "string" ? super.check(address, type) : super.check(address);
    }
  }
  return { ...actual, default: { ...actual, BlockList: StandInBlockList }, BlockList: StandInBlockList };
});

const SHIP = "ship-tile-r1";
const HANG_LIMIT_MS = 3000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;
let dir: string;
let round: string;
const fifos: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-frames-"));
  dir = path.join(root, "rounds");
  await cp(FIXTURE_ROUNDS.dir, dir, { recursive: true });
  round = path.join(dir, SHIP);
});

afterEach(async () => {
  for (const file of fifos.splice(0)) {
    const writer = await open(file, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null);
    await writer?.close();
  }
  await rm(root, { recursive: true, force: true });
});

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const frame = (key: string, view: "head" | "base" | "diff" = "head", id = SHIP) => getFrame({ dir }, id, key, view);

async function expectRefused(read: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(read).rejects.toMatchObject({ code: EXIT.NOINPUT, message: expect.stringMatching(message) });
}

async function writeFramesIndex(frames: unknown[]): Promise<void> {
  await writeFile(path.join(round, "frames", "frames.json"), JSON.stringify({ schema: "titan-review/frames@1", frames }));
}

describe("rounds.frame reads a listed frame", () => {
  it("returns a listed key's PNG bytes with the sha256 the frames index names", async () => {
    const bytes = await readFile(path.join(round, "images", "tile-light.png"));

    const read = await frame("tile-light");

    expect(read).toEqual({ contentType: "image/png", bytes: bytes.length, sha256: sha256Of(bytes), base64: bytes.toString("base64") });
    expect(read.sha256).toBe("c433e8a25aa52d9ba9aa449cc5957480c3393dbf14d654b96c3ac050670850be");
  });

  it("returns a new image the frames index does not list, with its computed sha256", async () => {
    const bytes = await readFile(path.join(round, "images", "badge-new.png"));

    expect(await frame("badge-new")).toMatchObject({ bytes: bytes.length, sha256: sha256Of(bytes) });
  });

  it("returns the base and diff files a frames record names for each view", async () => {
    const base = await readFile(path.join(round, "base", "tile-dark.png"));
    const diff = await readFile(path.join(round, "diff", "tile-dark.png"));

    expect((await frame("tile-dark", "base")).base64).toBe(base.toString("base64"));
    expect((await frame("tile-dark", "diff")).base64).toBe(diff.toString("base64"));
  });

  it("indexes head, base, diff and theme per key, and no entry for a story variant", async () => {
    const { entries } = await frameIndex(round);
    const story = await frameIndex(path.join(dir, "lantern-cards-r1"));

    expect(entries.get("tile-light")).toEqual({ files: { head: "images/tile-light.png", base: "base/tile-light.png", diff: "diff/tile-light.png" }, theme: "light" });
    expect(entries.get("panel-wide")?.files).toEqual({ head: "images/panel-wide.png", base: "base/panel-wide.png" });
    expect(entries.get("badge-new")).toEqual({ files: { head: "images/badge-new.png" } });
    expect(story.entries.size).toBe(0);
  });
});

describe("rounds.frame refuses what the round does not list", () => {
  it("refuses a view the key has no file for", async () => {
    await expectRefused(frame("panel-wide", "diff"), /lists no diff view of "panel-wide"/);
    await expectRefused(frame("badge-new", "base"), /lists no base view of "badge-new"/);
  });

  it("refuses a key that is a real file name but not listed, rather than opening it", async () => {
    await writeFile(path.join(round, "images", "stray.png"), PNG_SIGNATURE);

    await expectRefused(frame("stray"), /lists no head view of "stray"/);
    await expectRefused(frame("../round"), /lists no head view/);
  });

  it("refuses a story variant's key, which names no image", async () => {
    await expectRefused(frame("compact", "head", "lantern-cards-r1"), /lists no head view of "compact"/);
  });

  it("refuses an unknown round, and a round id that is a symlink", async () => {
    await symlink(round, path.join(dir, "linked-r1"));

    await expectRefused(frame("tile-light", "head", "missing-r1"), /No round named "missing-r1"/);
    await expectRefused(frame("tile-light", "head", "linked-r1"), /No round named "linked-r1"/);
  });

  it("refuses an index record whose file climbs out of the round or is absolute", async () => {
    const outside = path.join(root, "outside.png");
    await writeFile(outside, PNG_SIGNATURE);
    const sha256 = sha256Of(PNG_SIGNATURE);
    await writeFramesIndex([
      { key: "climb", file: "../kiln-schedule-r1/../../outside.png", sha256 },
      { key: "absolute", file: outside, sha256 },
    ]);

    await expectRefused(frame("climb"), /its path is not a relative \.png path/);
    await expectRefused(frame("absolute"), /its path is not a relative \.png path/);
  });
});

describe("rounds.frame refuses an unsafe file", () => {
  it("refuses when a directory on the path is a symlink to a copy outside the round", async () => {
    const outside = path.join(root, "outside-images");
    await cp(path.join(round, "images"), outside, { recursive: true });
    await rm(path.join(round, "images"), { recursive: true });
    await symlink(outside, path.join(round, "images"));

    await expectRefused(frame("badge-new"), /a directory on its path is a symlink or missing/);
  });

  it("refuses a PNG that is itself a symlink, even to a file inside the round", async () => {
    await rm(path.join(round, "images", "badge-new.png"));
    await symlink(path.join(round, "base", "tile-dark.png"), path.join(round, "images", "badge-new.png"));

    await expectRefused(frame("badge-new"), /the file is a symlink/);
  });

  it("refuses a FIFO at the image path instead of hanging", async () => {
    const file = path.join(round, "images", "badge-new.png");
    await rm(file);
    execFileSync("mkfifo", [file]);
    fifos.push(file);

    const limit = new Promise((_, reject) => setTimeout(() => reject(new Error("the read hung")), HANG_LIMIT_MS).unref());
    await expectRefused(Promise.race([frame("badge-new"), limit]), /not a regular file/);
  });

  it("reads a PNG exactly at the size cap and refuses one byte over", async () => {
    const file = path.join(round, "images", "badge-new.png");
    const atCap = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_FRAME_BYTES - PNG_SIGNATURE.length)]);
    await writeFile(file, atCap);
    expect((await frame("badge-new")).bytes).toBe(MAX_FRAME_BYTES);

    await writeFile(file, Buffer.concat([atCap, Buffer.alloc(1)]));
    await expectRefused(frame("badge-new"), new RegExp(`over ${MAX_FRAME_BYTES} bytes`));
  });

  it("refuses a file with a .png name and JPEG bytes", async () => {
    await writeFile(path.join(round, "images", "badge-new.png"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]));

    await expectRefused(frame("badge-new"), /the file is not a PNG/);
  });

  it("refuses a PNG whose bytes no longer match the frames index sha256", async () => {
    const file = path.join(round, "images", "tile-light.png");
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from([0])]));

    await expectRefused(frame("tile-light"), /does not match the frames index sha256/);
  });

  it("refuses every frame of a round whose frames dir is a symlink, or whose index is not frames@1", async () => {
    await writeFile(path.join(round, "frames", "frames.json"), JSON.stringify({ schema: "titan-review/frames@9", frames: [] }));
    await expectRefused(frame("badge-new"), /not a frames@1 index/);

    const outside = path.join(root, "outside-frames");
    await cp(path.join(round, "frames"), outside, { recursive: true });
    await rm(path.join(round, "frames"), { recursive: true });
    await symlink(outside, path.join(round, "frames"));
    await expectRefused(frame("badge-new"), /a directory on its path is a symlink or missing/);
  });

  it("never names a path in a refusal", async () => {
    await writeFile(path.join(round, "images", "badge-new.png"), "not a png");

    const caught: unknown = await frame("badge-new").then(() => null, (error: unknown) => error);
    const message = caught instanceof Error ? caught.message : "";

    expect(message).toMatch(/^frame refused: /);
    expect(message).not.toContain(root);
    expect(message).not.toContain("images/");
  });
});

// Linux routes all of 127/8 to lo; macOS answers only 127.0.0.1 unless an alias is added.
describe.skipIf(process.platform !== "linux")("rounds.frame over the LAN listener (127.0.0.2 stands in for the LAN)", () => {
  const NAME = "lan-box";
  const json = { "content-type": "application/json" };
  let handle: DaemonHandle | undefined;
  let pair: SelfSignedPair;
  let config: ConsoleConfig;

  beforeEach(async () => {
    pair = writeSelfSignedCert(root, [NAME, LAN]);
    config = {
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
      lanHost: LAN,
      lanNames: [NAME],
      lanTls: { certFile: pair.certFile, keyFile: pair.keyFile },
      lanTokenPath: path.join(root, "state", "lan.token"),
      ownerWrites: false,
      gateAnswers: false,
      inboxDir: path.join(root, "state", "inbox", "deposits"),
      roundsDir: dir,
    };
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(config.sessionGraphPath, "synthetic");
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    config = { ...config, port: handle.port };
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const lan = (route: string, headers: Record<string, string>, body: string): Promise<Reply> =>
    send(LAN, config.port, "POST", route, { host: `${NAME}:${config.port}`, origin: `https://${NAME}:${config.port}`, ...json, ...headers }, body, { ca: pair.cert, servername: NAME });

  async function signIn(): Promise<Record<string, string>> {
    const code = new URL(createLoginLink(config)).searchParams.get("code") ?? "";
    const login = await lan("/auth/login", {}, JSON.stringify({ code }));
    return { cookie: sessionCookie(login)!.split(";")[0]! };
  }

  it("serves a frame to a bearer and to a session cookie, as a read command", async () => {
    const bearer = { authorization: `Bearer ${readFileSync(config.lanTokenPath, "utf8").trim()}` };
    const args = JSON.stringify({ id: SHIP, key: "tile-dark", view: "diff" });

    const withBearer = await lan("/rpc/rounds.frame", bearer, args);
    const withCookie = await lan("/rpc/rounds.frame", await signIn(), args);
    const anonymous = await lan("/rpc/rounds.frame", {}, args);

    expect([withBearer.status, withCookie.status, anonymous.status]).toEqual([200, 200, 401]);
    expect(JSON.parse(withBearer.body)).toMatchObject({ ok: true, data: { contentType: "image/png", sha256: "9e2349bb0e5b6487c6c285687b78ece0b780c5ac34685519efc7845029595cb5" } });
  });

  it("refuses a key that is not a plain name before any lookup", async () => {
    const bearer = { authorization: `Bearer ${readFileSync(config.lanTokenPath, "utf8").trim()}` };

    const reply = await lan("/rpc/rounds.frame", bearer, JSON.stringify({ id: SHIP, key: "../round" }));

    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain(root);
  });
});
