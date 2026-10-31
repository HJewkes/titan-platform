import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePngBounded, encodePng } from "@titan-design/png-delta";
import { EXIT } from "@titan-design/registry";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { deltaCache, getFrameDelta } from "./round-frame-delta.js";

const SHIP = "ship-tile-r1";
const WHITE = [255, 255, 255, 255] as const;
const BLACK = [0, 0, 0, 255] as const;

let root: string;
let dir: string;
let round: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-frame-delta-"));
  dir = path.join(root, "rounds");
  await cp(FIXTURE_ROUNDS.dir, dir, { recursive: true });
  round = path.join(dir, SHIP);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A white `width`×`height` PNG with a black square of side `square` at (2, 2), and one pixel at `dot` painted red. */
function png(width: number, height: number, { square = 4, dot }: { square?: number; dot?: [number, number] } = {}): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set(x >= 2 && x < 2 + square && y >= 2 && y < 2 + square ? BLACK : WHITE, (y * width + x) * 4);
  }
  if (dot) rgba.set([255, 0, 0, 255], (dot[1] * width + dot[0]) * 4);
  return encodePng({ width, height, rgba });
}

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Writes each frame's base and head PNGs into the round and lists them, with their sha256s, in frames/frames.json. */
async function writeFrames(frames: Record<string, { base: Buffer; head: Buffer; after?: Buffer }>): Promise<void> {
  const records = [];
  for (const [key, { base, head, after }] of Object.entries(frames)) {
    await writeFile(path.join(round, "base", `${key}.png`), base);
    await writeFile(path.join(round, "images", `${key}.png`), head);
    if (after) await writeFile(path.join(round, "images", `${key}.after.png`), after);
    const listedAfter = after && { after: { file: `images/${key}.after.png`, sha256: sha256Of(after) } };
    records.push({ key, file: `images/${key}.png`, sha256: sha256Of(head), base: { file: `base/${key}.png`, sha256: sha256Of(base) }, ...listedAfter });
  }
  await writeFile(path.join(round, "frames", "frames.json"), JSON.stringify({ schema: "titan-review/frames@1", frames: records }));
}

const delta = (key: string, cache = deltaCache()) => getFrameDelta({ dir }, SHIP, key, cache);

async function expectRefused(read: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(read).rejects.toMatchObject({ code: EXIT.NOINPUT, message: expect.stringMatching(message) });
}

describe("rounds.frameDelta measures a changed frame", () => {
  it("draws a delta PNG with the changed-pixel count and share for a changed pair", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(10, 10, { dot: [3, 3] }) } });

    const read = await delta("tile-light");

    expect(read).toMatchObject({ status: "changed", changedPixels: 1, share: 1 / 16, width: 10, height: 10, contentType: "image/png" });
    const image = read.status === "changed" ? decodePngBounded(Buffer.from(read.base64, "base64"), { maxPixels: 100 }) : null;
    expect(image).toMatchObject({ width: 10, height: 10 });
  });

  it("gives no delta for a frame whose main and head render the same", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(10, 10) } });

    expect(await delta("tile-light")).toEqual({ status: "unchanged" });
  });

  it("compares a CI packet's after image, not its montage, so an after that matches main gives no delta", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(30, 10), after: png(10, 10) } });

    expect(await delta("tile-light")).toEqual({ status: "unchanged" });
  });

  it("says the sizes differ instead of drawing when main and head are different sizes", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(12, 10) } });

    expect(await delta("tile-light")).toEqual({ status: "sizesDiffer", base: { width: 10, height: 10 }, head: { width: 12, height: 10 } });
  });

  it("reuses the measure for the same base and head, and measures afresh when the head changes", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(10, 10, { dot: [3, 3] }) } });
    const cache = deltaCache();
    const compute = vi.fn();
    const counted: typeof cache = (key, run) =>
      cache(key, () => {
        compute();
        return run();
      });

    const first = await getFrameDelta({ dir }, SHIP, "tile-light", counted);
    await getFrameDelta({ dir }, SHIP, "tile-light", counted);
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(10, 10, { square: 2 }) } });
    const next = await getFrameDelta({ dir }, SHIP, "tile-light", counted);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(next).not.toEqual(first);
  });
});

describe("rounds.frameDelta off the event loop", () => {
  it("answers a cheap read while a large delta is still computing", async () => {
    await writeFrames({
      "tile-big": { base: png(2400, 2400), head: png(2400, 2400, { square: 6 }) },
      "tile-same": { base: png(4, 4), head: png(4, 4) },
    });

    const big = delta("tile-big");
    const settled = vi.fn();
    void big.then(settled);
    const cheap = await delta("tile-same");

    expect(cheap).toEqual({ status: "unchanged" });
    expect(settled).not.toHaveBeenCalled();
    expect(await big).toMatchObject({ status: "changed" });
  });
});

describe("the delta cache", () => {
  it("drops the least recently used entry once it is full", () => {
    const cache = deltaCache(2);
    const compute = vi.fn(() => ({ status: "unmeasured" as const, reason: "stub" }));

    for (const key of ["a", "b", "a", "c", "a", "b"]) cache(key, compute);

    expect(compute).toHaveBeenCalledTimes(4);
  });
});

describe("rounds.frameDelta refuses what rounds.frame refuses", () => {
  it("refuses a key the round does not list", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(10, 10, { dot: [3, 3] }) } });

    await expectRefused(delta("not-listed"), /lists no base and head views of "not-listed"/);
  });

  it("refuses a frame the round lists with a head but no base", async () => {
    await expectRefused(delta("badge-new"), /lists no base and head views of "badge-new"/);
  });

  it("refuses a listed base that is a symlink", async () => {
    await writeFrames({ "tile-light": { base: png(10, 10), head: png(10, 10, { dot: [3, 3] }) } });
    await rm(path.join(round, "base", "tile-light.png"));
    await symlink(path.join(round, "images", "tile-light.png"), path.join(round, "base", "tile-light.png"));

    await expectRefused(delta("tile-light"), /the file is a symlink/);
  });
});
