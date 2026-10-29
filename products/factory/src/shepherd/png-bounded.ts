// A PNG decoder for snapshot blobs a pull request supplies (TP-4320 S3b). Every allocation is sized from a header
// already checked against `maxPixels`, and the inflate carries that size as its own limit, so the PR's bytes can make
// the decode refuse but never make it do more work. A general decoder (pngjs) sizes its work from fields the PR
// controls, and guarding it by predicting its behaviour did not converge (#2594).
import zlib from "node:zlib";

/** A decoded image as 8-bit RGBA, row-major, with no padding. */
export interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface Refused {
  readonly refused: string;
}

interface PngLimits {
  readonly maxPixels: number;
}

interface Header {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
  readonly compression: number;
  readonly filter: number;
  readonly interlace: number;
}

interface Walk {
  header: Header | null;
  readonly idat: Uint8Array[];
  previous: string;
  ended: boolean;
}

interface Chunks {
  readonly header: Header;
  readonly idat: readonly Uint8Array[];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR_LENGTH = 13;
/** Length, type and CRC around each chunk's data. */
const CHUNK_OVERHEAD = 12;
const RGBA = 6;
const RGB = 2;

const refuse = (reason: string): Refused => ({ refused: reason });

/** The refusal for a header over `maxPixels`, so a caller can tell it from the others. */
export const overPixels = (maxPixels: number): string => `over ${maxPixels} pixels`;

function hasSignature(bytes: Uint8Array): boolean {
  return bytes.length >= SIGNATURE.length && SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function readHeader(data: Uint8Array): Header {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: view.getUint32(0),
    height: view.getUint32(4),
    bitDepth: view.getUint8(8),
    colourType: view.getUint8(9),
    compression: view.getUint8(10),
    filter: view.getUint8(11),
    interlace: view.getUint8(12),
  };
}

function takeHeader(walk: Walk, data: Uint8Array): Refused | null {
  if (data.length !== IHDR_LENGTH) return refuse("bad IHDR length");
  walk.header = readHeader(data);
  return null;
}

function takeData(walk: Walk, data: Uint8Array): Refused | null {
  if (walk.idat.length > 0 && walk.previous !== "IDAT") return refuse("IDAT chunks not consecutive");
  walk.idat.push(data);
  return null;
}

/** A critical chunk has an upper-case first letter; one this decoder does not know cannot be skipped safely. */
const isCritical = (type: string): boolean => (type.charCodeAt(0) & 0x20) === 0;

function takeChunk(walk: Walk, type: string, data: Uint8Array): Refused | null {
  if (walk.header === null) return type === "IHDR" ? takeHeader(walk, data) : refuse("IHDR not first");
  if (type === "IHDR") return refuse("second IHDR");
  if (type === "IDAT") return takeData(walk, data);
  if (type === "IEND") walk.ended = true;
  else if (isCritical(type) && type !== "PLTE") return refuse("unknown critical chunk");
  return null;
}

function finish(walk: Walk, at: number, length: number): Chunks | Refused {
  if (walk.header === null || !walk.ended) return refuse("no IEND");
  if (at < length) return refuse("data after IEND");
  return walk.idat.length === 0 ? refuse("no image data") : { header: walk.header, idat: walk.idat };
}

/** Reads every chunk boundary before any inflate, so a later chunk cannot change what an earlier check accepted. */
function walkChunks(bytes: Uint8Array): Chunks | Refused {
  if (!hasSignature(bytes)) return refuse("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk: Walk = { header: null, idat: [], previous: "", ended: false };
  let at = SIGNATURE.length;
  while (at < bytes.length && !walk.ended) {
    if (at + CHUNK_OVERHEAD > bytes.length) return refuse("truncated chunk");
    const end = at + CHUNK_OVERHEAD + view.getUint32(at);
    if (end > bytes.length) return refuse("truncated chunk");
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const refusal = takeChunk(walk, type, bytes.subarray(at + 8, end - 4));
    if (refusal) return refusal;
    walk.previous = type;
    at = end;
  }
  return finish(walk, at, bytes.length);
}

/** Only what Playwright writes: 8-bit RGB or RGBA, not interlaced. Anything else stays unmeasured. */
function isSupported(header: Header): boolean {
  if (header.bitDepth !== 8 || header.compression !== 0 || header.filter !== 0) return false;
  if (header.interlace !== 0) return false;
  return header.colourType === RGB || header.colourType === RGBA;
}

function headerRefusal(header: Header, limits: PngLimits): Refused | null {
  if (!isSupported(header)) return refuse("unsupported PNG format");
  if (header.width === 0 || header.height === 0) return refuse("empty image");
  if (header.width * header.height > limits.maxPixels) return refuse(overPixels(limits.maxPixels));
  return null;
}

/** The limit sits inside the zlib call, so neither the compression ratio nor any chunk trick can raise memory past it. */
function inflateBounded(idat: readonly Uint8Array[], expected: number): Buffer | Refused {
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (error) {
    return refuse(error instanceof RangeError ? "inflates past its declared size" : "corrupt image data");
  }
  return raw.length < expected ? refuse("truncated image data") : raw;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >>> 1;
  if (filter === 4) return paeth(left, up, upLeft);
  return 0;
}

function unfilterRow(filter: number, row: Uint8Array, above: Uint8Array, bpp: number): void {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
    const upLeft = i >= bpp ? (above[i - bpp] ?? 0) : 0;
    row[i] = ((row[i] ?? 0) + predict(filter, left, above[i] ?? 0, upLeft)) & 0xff;
  }
}

function copyRow(rgba: Uint8Array, row: Uint8Array, offset: number, bpp: number): void {
  if (bpp === 4) {
    rgba.set(row, offset);
    return;
  }
  for (let source = 0, target = offset; source < row.length; source += 3, target += 4) {
    rgba.set(row.subarray(source, source + 3), target);
    rgba[target + 3] = 255;
  }
}

function unfilter(raw: Buffer, header: Header): Decoded | Refused {
  const bpp = header.colourType === RGBA ? 4 : 3;
  const stride = header.width * bpp;
  const rgba = new Uint8Array(header.width * header.height * 4);
  let above: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < header.height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw.readUInt8(start);
    if (filter > 4) return refuse("bad filter type");
    const row = raw.subarray(start + 1, start + 1 + stride);
    unfilterRow(filter, row, above, bpp);
    copyRow(rgba, row, y * header.width * 4, bpp);
    above = row;
  }
  return { width: header.width, height: header.height, rgba };
}

/**
 * Decodes an untrusted PNG, or says why it will not. Peak memory is at most `maxPixels × 8` plus the image height,
 * beside the input itself, whatever the bytes claim or contain.
 */
export function decodePngBounded(bytes: Uint8Array, limits: PngLimits): Decoded | Refused {
  const chunks = walkChunks(bytes);
  if ("refused" in chunks) return chunks;
  const { header } = chunks;
  const refusal = headerRefusal(header, limits);
  if (refusal) return refusal;
  const bpp = header.colourType === RGBA ? 4 : 3;
  const raw = inflateBounded(chunks.idat, header.height * (1 + header.width * bpp));
  return "refused" in raw ? raw : unfilter(raw, header);
}
