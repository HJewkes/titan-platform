// The smallest PNG writer a delta image needs: 8-bit RGBA, no interlace, filter 0 on every row. Its output decodes
// through `decodePngBounded`, so a delta takes the same read path as the frames it was drawn from.
import zlib from "node:zlib";
import type { Decoded } from "./png-bounded.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RGBA = 6;

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(8, 8);
  data.writeUInt8(RGBA, 9);
  return data;
}

/** Each row is its filter byte, 0, then the row's RGBA bytes as they are. */
function scanlines({ width, height, rgba }: Decoded): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return raw;
}

/** Encodes an RGBA image as a PNG. The caller's image is already bounded, so the output is too. */
export function encodePng(image: Decoded): Buffer {
  if (image.rgba.length !== image.width * image.height * 4) throw new RangeError("rgba length does not match width × height × 4");
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header(image.width, image.height)),
    chunk("IDAT", zlib.deflateSync(scanlines(image))),
    chunk("IEND", new Uint8Array()),
  ]);
}
