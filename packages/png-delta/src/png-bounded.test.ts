import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { PNG } from "pngjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodePngBounded } from "./png-bounded.js";
import { encodePng } from "./png-encode.js";

const MiB = 1024 * 1024;
const LIMITS = { maxPixels: 16 * MiB };
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

interface HeaderFields {
  width?: number;
  height?: number;
  bitDepth?: number;
  colourType?: number;
  interlace?: number;
}

function ihdr({ width = 1, height = 1, bitDepth = 8, colourType = 6, interlace = 0 }: HeaderFields = {}): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.set([bitDepth, colourType, 0, 0, interlace], 8);
  return chunk("IHDR", data);
}

const idat = (raw: Uint8Array): Buffer => chunk("IDAT", zlib.deflateSync(raw));
const IEND = chunk("IEND");
const png = (...chunks: Uint8Array[]): Buffer => Buffer.concat([SIGNATURE, ...chunks]);
/** One opaque black RGBA pixel behind filter byte 0. */
const ONE_PIXEL = Uint8Array.of(0, 0, 0, 0, 255);

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

function expectRefusedWithinBound(bytes: Uint8Array, reason: string): void {
  const before = process.memoryUsage().arrayBuffers;
  const result = decodePngBounded(bytes, LIMITS);
  const grown = process.memoryUsage().arrayBuffers - before;

  expect(grown).toBeLessThan(64 * MiB);
  expect(result).toEqual({ refused: reason });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decodePngBounded refuses adversarial snapshots within its memory bound", () => {
  let zeros200MiB: Buffer;
  beforeAll(async () => {
    zeros200MiB = await deflatedZeros(200 * MiB);
  });

  // pngjs 7 keeps the last IHDR, so the interlaced second header inflated the whole 200 MiB (#2594 round 3).
  it("refuses a second IHDR that turns on interlace ahead of a 200 MiB IDAT", () => {
    const bytes = png(ihdr(), ihdr({ interlace: 1 }), chunk("IDAT", zeros200MiB), IEND);

    expectRefusedWithinBound(bytes, "second IHDR");
  });

  // pngjs 7 sizes its buffers from the last IHDR, here 20000×20000.
  it("refuses a second IHDR that declares 20000×20000", () => {
    const bytes = png(ihdr(), ihdr({ width: 20_000, height: 20_000 }), idat(ONE_PIXEL), IEND);

    expectRefusedWithinBound(bytes, "second IHDR");
  });

  // pngjs 7 inflates the whole stream before it compares the length with the header.
  it("refuses an honest 1×1 header whose IDAT inflates to 200 MiB inside the zlib call", () => {
    const bytes = png(ihdr(), chunk("IDAT", zeros200MiB), IEND);

    expectRefusedWithinBound(bytes, "inflates past its declared size");
  });

  it.each([
    ["interlace 1", { interlace: 1 }],
    ["bit depth 16", { bitDepth: 16 }],
    ["colour type 3 (palette)", { colourType: 3 }],
    ["colour type 0 (greyscale)", { colourType: 0 }],
  ])("refuses %s as an unsupported format", (_name, fields: HeaderFields) => {
    expectRefusedWithinBound(png(ihdr(fields), idat(ONE_PIXEL), IEND), "unsupported PNG format");
  });

  it.each([
    ["20000×20000", 20_000, 20_000],
    ["0xFFFFFFFF × 0xFFFFFFFF", 0xffffffff, 0xffffffff],
  ])("refuses a declared %s before any inflate", (_name, width, height) => {
    const inflate = vi.spyOn(zlib, "inflateSync");

    expectRefusedWithinBound(png(ihdr({ width, height }), idat(ONE_PIXEL), IEND), `over ${LIMITS.maxPixels} pixels`);
    expect(inflate).not.toHaveBeenCalled();
  });

  it.each([
    ["width", { width: 0 }],
    ["height", { height: 0 }],
  ])("refuses a zero %s", (_name, fields: HeaderFields) => {
    expectRefusedWithinBound(png(ihdr(fields), idat(ONE_PIXEL), IEND), "empty image");
  });

  it("refuses a file whose first chunk is tEXt", () => {
    expectRefusedWithinBound(png(chunk("tEXt", Buffer.from("k\0v")), ihdr(), idat(ONE_PIXEL), IEND), "IHDR not first");
  });

  it("refuses a 0x7FFFFFFF length field in a 100-byte file", () => {
    const lying = Buffer.alloc(100 - SIGNATURE.length - 25);
    lying.writeUInt32BE(0x7fffffff, 0);
    lying.write("IDAT", 4, "latin1");

    expectRefusedWithinBound(png(ihdr(), lying), "truncated chunk");
  });

  it.each([
    ["no IEND", png(ihdr(), idat(ONE_PIXEL)), "no IEND"],
    ["IDAT after IEND", png(ihdr(), idat(ONE_PIXEL), IEND, idat(ONE_PIXEL)), "data after IEND"],
    ["split IDATs", png(ihdr(), idat(ONE_PIXEL), chunk("tEXt"), idat(ONE_PIXEL), IEND), "IDAT chunks not consecutive"],
    ["no IDAT", png(ihdr(), IEND), "no image data"],
    ["an IHDR of the wrong length", png(chunk("IHDR", Buffer.alloc(12)), IEND), "bad IHDR length"],
    ["an unknown critical chunk", png(ihdr(), chunk("ZZZZ"), idat(ONE_PIXEL), IEND), "unknown critical chunk"],
  ])("refuses %s", (_name, bytes: Buffer, reason: string) => {
    expectRefusedWithinBound(bytes, reason);
  });

  it("refuses image data that inflates short of the header's size", () => {
    expectRefusedWithinBound(png(ihdr({ width: 2 }), idat(ONE_PIXEL), IEND), "truncated image data");
  });

  it("refuses image data that is not a zlib stream", () => {
    expectRefusedWithinBound(png(ihdr(), chunk("IDAT", Buffer.from("not zlib")), IEND), "corrupt image data");
  });

  it("refuses a row filter type past 4", () => {
    expectRefusedWithinBound(png(ihdr(), idat(Uint8Array.of(5, 0, 0, 0, 255)), IEND), "bad filter type");
  });

  it("refuses a bad signature", () => {
    const bytes = png(ihdr(), idat(ONE_PIXEL), IEND);
    bytes[1] = 0;

    expectRefusedWithinBound(bytes, "not a PNG");
  });
});

/** A deterministic noise image, so every filter type has neighbours to predict from. */
function noise(width: number, height: number, opaque: boolean): PNG {
  const image = new PNG({ width, height });
  let seed = 7;
  for (let i = 0; i < image.data.length; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    image.data[i] = opaque && i % 4 === 3 ? 255 : seed >>> 23;
  }
  return image;
}

describe("decodePngBounded decodes what Playwright writes", () => {
  it.each([-1, 0, 1, 2, 3, 4])("matches pngjs byte for byte for RGBA and RGB under filter type %i", (filterType) => {
    for (const colorType of [6, 2] as const) {
      const encoded = PNG.sync.write(noise(23, 17, colorType === 2), { colorType, filterType });

      const decoded = decodePngBounded(encoded, LIMITS);

      expect(decoded).toEqual({ width: 23, height: 17, rgba: new Uint8Array(PNG.sync.read(encoded).data) });
    }
  });

  it("decodes an image of exactly maxPixels", () => {
    const decoded = decodePngBounded(PNG.sync.write(noise(40, 25, false)), { maxPixels: 1000 });

    expect(decoded).toMatchObject({ width: 40, height: 25 });
  });
});

describe("png-delta runtime code", () => {
  it("never imports pngjs, so untrusted snapshots only reach the bounded decoder", () => {
    const src = fileURLToPath(new URL(".", import.meta.url));
    const runtime = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.[cm]?tsx?$/.test(path) && !/\.test(-helpers)?\.ts$/.test(path));

    const importers = runtime.filter((path) => /["']pngjs["']/.test(readFileSync(join(src, path), "utf8")));

    expect(runtime).toContain("delta.ts");
    expect(importers).toEqual([]);
  });
});

describe("encodePng", () => {
  it("writes a PNG the bounded decoder and pngjs both read back pixel for pixel", () => {
    const image = noise(23, 17, false);
    const decoded = { width: 23, height: 17, rgba: new Uint8Array(image.data) };

    const encoded = encodePng(decoded);

    expect(decodePngBounded(encoded, LIMITS)).toEqual(decoded);
    expect(new Uint8Array(PNG.sync.read(encoded).data)).toEqual(decoded.rgba);
  });

  it("refuses rgba whose length does not match its size", () => {
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(12) })).toThrow(RangeError);
  });
});
