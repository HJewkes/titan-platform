import { once } from "node:events";
import zlib from "node:zlib";
import { githubPort } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePngBounded } from "./png-bounded.js";
import { OVER_BUDGET } from "./visual-delta-measure.js";
import { HEAD, SHOT, THRESHOLD, card, evidence, pair, world } from "./visual-delta-read.test-helpers.js";

vi.mock("./png-bounded.js", async (original) => {
  const actual = await original<typeof import("./png-bounded.js")>();
  return { ...actual, decodePngBounded: vi.fn(actual.decodePngBounded) };
});

const MiB = 1024 * 1024;
const shot = (name: string) => `ui/visual/stories.spec.ts-snapshots/${name}--default-chromium-linux.png`;
const modified = (...paths: string[]) => paths.map((path) => ({ path, status: "modified" }));
const reasons = (snapshots: { reason?: string }[] | undefined) => snapshots?.map((snapshot) => snapshot.reason);

function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function ihdr(interlace: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(1, 0);
  data.writeUInt32BE(1, 4);
  data.set([8, 6, 0, 0, interlace], 8);
  return chunk("IHDR", data);
}

/** Deflates `size` zero bytes from one reused block, so building the bomb never holds its inflated size. */
async function deflatedZeros(size: number): Promise<Buffer> {
  const deflate = zlib.createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (part: Buffer) => parts.push(part));
  const ended = once(deflate, "end");
  const block = Buffer.alloc(MiB);
  for (let written = 0; written < size; written += MiB) deflate.write(block);
  deflate.end();
  await ended;
  return Buffer.concat(parts);
}

afterEach(() => {
  vi.mocked(decodePngBounded).mockClear();
});

describe("measuring snapshot pairs under the step's fixed caps", () => {
  // The #2594 round-3 shape: pngjs kept the interlaced second IHDR and inflated the whole 200 MiB.
  it("records a head with a second, interlaced IHDR over a 200 MiB IDAT as unmeasured within 64 MiB", async () => {
    const bomb = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr(0), ihdr(1), chunk("IDAT", await deflatedZeros(200 * MiB)), chunk("IEND")]);
    const fake = world(modified(SHOT), pair(SHOT, card(), bomb));
    const before = process.memoryUsage().arrayBuffers;

    const { record } = await evidence(fake, THRESHOLD);

    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * MiB);
    expect(reasons(record.visualDelta?.snapshots)).toEqual(["head: second IHDR"]);
  });

  it("records a blob over maxBytes as unmeasured without the fake serving it", async () => {
    const fake = world(modified(SHOT), pair(SHOT, new Uint8Array(50 * MiB), card()));

    const { record } = await evidence(fake, { ...THRESHOLD, maxBytes: 5 * MiB });

    expect(reasons(record.visualDelta?.snapshots)).toEqual(["base: over 5242880 bytes"]);
    expect(fake.calls.filter((call) => call === "getContentBytes")).toEqual([]);
  });

  it("measures the first of three 64×64 pairs under a two-image budget, and neither reads nor decodes the others", async () => {
    const [a, b, c] = [shot("a"), shot("b"), shot("c")];
    const fake = world(modified(a, b, c), { ...pair(a, card(false, 64), card(true, 64)), ...pair(b, card(false, 64), card(true, 64)), ...pair(c, card(false, 64), card(true, 64)) });

    const { record } = await evidence(fake, { ...THRESHOLD, maxTotalPixels: 2 * 64 * 64 });

    expect(record.visualDelta?.snapshots.map((s) => [s.component, s.status, s.reason])).toEqual([["b", "unmeasured", OVER_BUDGET], ["c", "unmeasured", OVER_BUDGET], ["a", "changed", undefined]]);
    expect(vi.mocked(decodePngBounded)).toHaveBeenCalledTimes(2);
    expect(fake.calls.filter((call) => call === "getContentBytes")).toHaveLength(2);
  });

  it("refuses a head larger than the budget left after its base, as over the step's budget", async () => {
    const fake = world(modified(SHOT), pair(SHOT, card(false, 64), card(true, 64)));

    const { record } = await evidence(fake, { ...THRESHOLD, maxTotalPixels: 64 * 64 + 100 });

    expect(reasons(record.visualDelta?.snapshots)).toEqual([OVER_BUDGET]);
    expect(vi.mocked(decodePngBounded).mock.calls.map(([, limits]) => limits.maxPixels)).toEqual([64 * 64 + 100, 100]);
  });

  it("records every pair unmeasured with no blob or merge-base read when they number over maxSnapshots", async () => {
    const fake = world(modified(shot("a"), shot("b"), shot("c")));

    const { record } = await evidence(fake, { ...THRESHOLD, maxSnapshots: 2 });

    expect(new Set(reasons(record.visualDelta?.snapshots))).toEqual(new Set(["3 changed snapshots are over the cap of 2"]));
    expect(fake.calls.filter((call) => call === "getContentBytes" || call === "compareFiles")).toEqual([]);
  });
});

describe("measuring snapshot pairs when GitHub reads fail", () => {
  it("records every pair unmeasured with a null merge base when the compare throws", async () => {
    const fake = world(modified(shot("a"), shot("b")));
    const port = { ...githubPort(fake.wire), compareFiles: () => Promise.reject(Object.assign(new Error("bad gateway"), { status: 502 })) };

    const { record } = await evidence(fake, THRESHOLD, port);

    expect(reasons(record.visualDelta?.snapshots)).toEqual(["the merge base is unreadable, HTTP 502", "the merge base is unreadable, HTTP 502"]);
    expect(record.visualDelta?.mergeBase).toBeNull();
    expect(fake.calls.filter((call) => call === "getContentBytes")).toEqual([]);
  });

  it("records an absent base and a throwing head read as unmeasured, without the step throwing", async () => {
    const [absent, failing] = [shot("absent"), shot("failing")];
    const fake = world(modified(absent, failing), pair(failing, card(), card(true)));
    const real = githubPort(fake.wire);
    const port = { ...real, fileBytes: (...args: Parameters<typeof real.fileBytes>) => (args[1] === failing && args[2] === HEAD ? Promise.reject(Object.assign(new Error("gone"), { status: 500 })) : real.fileBytes(...args)) };

    const { record } = await evidence(fake, THRESHOLD, port);

    expect(record.visualDelta?.snapshots.map((s) => [s.component, s.reason])).toEqual([["absent", "base: absent"], ["failing", "head: unreadable, HTTP 500"]]);
  });
});
