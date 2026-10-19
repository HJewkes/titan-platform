/**
 * What a video's own headers say: duration, frame size, orientation and whether it carries sound.
 * An mp4 is walked box by box with small positioned reads, so a `moov` at the end of a large file
 * costs a few headers and not the file; a webm's `Info` and `Tracks` sit before its first cluster,
 * so a bounded head is enough. A file whose headers cannot be parsed is reported, never thrown.
 *
 * Results are cached by what identifies a file's bytes, as the sha and sidecar caches are, because
 * `videos.list` rescans the roots on every request.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { OPEN_FLAGS } from "./rounds.js";

const FINGERPRINT_BYTES = 64 * 1024;
const WEBM_HEAD_BYTES = 256 * 1024;
const MAX_BOXES = 512;
const MAX_CACHED_MEDIA = 4096;
const BOX_HEADER_BYTES = 16;

export const mediaFields = {
  durationS: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  orientation: z.enum(["landscape", "portrait", "square"]).nullable(),
  audio: z.boolean().nullable(),
};

export type Media = z.infer<z.ZodObject<typeof mediaFields>>;

export const UNKNOWN_MEDIA: Media = { durationS: null, width: null, height: null, orientation: null, audio: null };

/** Each part is filled on first use: most files never need a fingerprint. */
interface Facts {
  media?: Media | "unreadable";
  fingerprint?: string;
}

const cache = new Map<string, Facts>();

class Corrupt extends Error {}

const keyOf = (info: Stats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;

function remember(info: Stats, learned: Facts): void {
  const key = keyOf(info);
  const known = cache.get(key);
  if (known === undefined && cache.size >= MAX_CACHED_MEDIA) cache.delete(cache.keys().next().value!);
  cache.set(key, { ...known, ...learned });
}

async function withHandle<T>(file: string, read: (handle: FileHandle) => Promise<T>): Promise<T> {
  const handle = await open(file, OPEN_FLAGS);
  try {
    return await read(handle);
  } finally {
    await handle.close();
  }
}

/** The file's headers, or "unreadable"; `info` is the scan's lstat, which keys the cache. */
export async function mediaOf(file: string, info: Stats): Promise<Media | "unreadable"> {
  const cached = cache.get(keyOf(info))?.media;
  if (cached !== undefined) return cached;
  const media = await withHandle(file, (handle) => readMedia(handle, file, info.size)).catch(() => "unreadable" as const);
  remember(info, { media });
  return media;
}

/** Size plus a hash of the first and last 64 KB: enough to tell a copy of a render from another render. */
export async function fingerprintOf(file: string, info: Stats): Promise<string | null> {
  const cached = cache.get(keyOf(info))?.fingerprint;
  if (cached !== undefined) return cached;
  const fingerprint = await withHandle(file, (handle) => hashEnds(handle, info.size)).catch(() => null);
  if (fingerprint !== null) remember(info, { fingerprint });
  return fingerprint;
}

async function hashEnds(handle: FileHandle, size: number): Promise<string> {
  const head = await readAt(handle, 0, FINGERPRINT_BYTES);
  const tail = await readAt(handle, Math.max(0, size - FINGERPRINT_BYTES), FINGERPRINT_BYTES);
  return `${size}:${createHash("sha256").update(head).update(tail).digest("hex")}`;
}

/** Up to `length` bytes from `position`; fewer at the end of the file. */
export async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

async function readMedia(handle: FileHandle, file: string, size: number): Promise<Media> {
  const parsed = file.toLowerCase().endsWith(".webm") ? parseWebm(await readAt(handle, 0, WEBM_HEAD_BYTES)) : await readMp4(handle, size);
  return { ...parsed, orientation: orientationOf(parsed.width, parsed.height) };
}

function orientationOf(width: number | null, height: number | null): Media["orientation"] {
  if (width === null || height === null) return null;
  return width > height ? "landscape" : width < height ? "portrait" : "square";
}

type Parsed = Omit<Media, "orientation">;

interface Box {
  type: string;
  body: number;
  end: number;
}

/** The boxes directly inside [start, end); one that overruns its parent means a truncated or corrupt file. */
async function childBoxes(handle: FileHandle, start: number, end: number): Promise<Box[]> {
  const boxes: Box[] = [];
  for (let at = start; at + 8 <= end; at = boxes.at(-1)!.end) {
    if (boxes.length >= MAX_BOXES) throw new Corrupt();
    const head = await readAt(handle, at, BOX_HEADER_BYTES);
    if (head.length < 8) throw new Corrupt();
    const declared = head.readUInt32BE(0);
    const large = declared === 1;
    if (large && head.length < 16) throw new Corrupt();
    const size = large ? Number(head.readBigUInt64BE(8)) : declared === 0 ? end - at : declared;
    const body = at + (large ? 16 : 8);
    if (at + size < body || at + size > end) throw new Corrupt();
    boxes.push({ type: head.toString("latin1", 4, 8), body, end: at + size });
  }
  return boxes;
}

const child = (boxes: readonly Box[], type: string) => boxes.find((box) => box.type === type);

function readBody(handle: FileHandle, box: Box, length: number): Promise<Buffer> {
  return readAt(handle, box.body, Math.min(length, box.end - box.body));
}

async function readMp4(handle: FileHandle, size: number): Promise<Parsed> {
  const moov = child(await childBoxes(handle, 0, size), "moov");
  if (moov === undefined) throw new Corrupt();
  const boxes = await childBoxes(handle, moov.body, moov.end);
  const mvhd = child(boxes, "mvhd");
  if (mvhd === undefined) throw new Corrupt();
  const durationS = mvhdDuration(await readBody(handle, mvhd, 32));
  const tracks = [];
  for (const trak of boxes.filter((box) => box.type === "trak")) tracks.push(await readTrack(handle, trak));
  const video = tracks.find((track) => track.handler === "vide");
  return { durationS, width: video?.width ?? null, height: video?.height ?? null, audio: tracks.some((track) => track.handler === "soun") };
}

function mvhdDuration(body: Buffer): number | null {
  const v1 = body[0] === 1;
  if (body.length < (v1 ? 32 : 20)) throw new Corrupt();
  const timescale = body.readUInt32BE(v1 ? 20 : 12);
  const duration = v1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
  const unknown = v1 ? duration >= Number.MAX_SAFE_INTEGER : duration === 0xffffffff;
  return timescale === 0 || unknown ? null : roundMs(duration / timescale);
}

const roundMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

async function readTrack(handle: FileHandle, trak: Box): Promise<{ handler: string | null; width: number | null; height: number | null }> {
  const boxes = await childBoxes(handle, trak.body, trak.end);
  const tkhd = child(boxes, "tkhd");
  const mdia = child(boxes, "mdia");
  const hdlr = mdia === undefined ? undefined : child(await childBoxes(handle, mdia.body, mdia.end), "hdlr");
  const handlerBody = hdlr === undefined ? null : await readBody(handle, hdlr, 12);
  const handler = handlerBody !== null && handlerBody.length === 12 ? handlerBody.toString("latin1", 8, 12) : null;
  return { handler, ...(tkhd === undefined ? { width: null, height: null } : tkhdSize(await readBody(handle, tkhd, 96))) };
}

/** The display size, swapped when the matrix turns the frame a quarter. */
function tkhdSize(body: Buffer): { width: number | null; height: number | null } {
  const matrix = body[0] === 1 ? 52 : 40;
  if (body.length < matrix + 44) throw new Corrupt();
  const width = Math.round(body.readUInt32BE(matrix + 36) / 65536);
  const height = Math.round(body.readUInt32BE(matrix + 40) / 65536);
  if (width === 0 || height === 0) return { width: null, height: null };
  const quarterTurn = body.readInt32BE(matrix) === 0 && body.readInt32BE(matrix + 16) === 0;
  return quarterTurn ? { width: height, height: width } : { width, height };
}

const EBML = {
  header: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
};

const TRACK_VIDEO = 1;
const TRACK_AUDIO = 2;

interface Element {
  id: number;
  body: number;
  end: number;
}

/** A variable-length integer: its byte length from the leading zeros of the first byte, or null past the head. */
function vint(head: Buffer, at: number, keepMarker: boolean): { value: number | null; length: number } | null {
  const first = head[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > head.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    value = value * 256 + head[at + index]!;
    allOnes &&= head[at + index] === 0xff;
  }
  return { value: !keepMarker && allOnes ? null : value, length };
}

/** The elements directly inside [start, end); an unknown size runs to the end of its parent. */
function elements(head: Buffer, start: number, end: number): Element[] {
  const found: Element[] = [];
  for (let at = start; at < end && found.length < MAX_BOXES; ) {
    const id = vint(head, at, true);
    const size = id === null ? null : vint(head, at + id.length, false);
    if (id === null || size === null) break;
    const body = at + id.length + size.length;
    const elementEnd = size.value === null ? end : body + size.value;
    found.push({ id: id.value!, body, end: Math.min(elementEnd, head.length) });
    at = elementEnd;
  }
  return found;
}

function parseWebm(head: Buffer): Parsed {
  const top = elements(head, 0, head.length);
  const segment = top.find((element) => element.id === EBML.segment);
  if (top[0]?.id !== EBML.header || segment === undefined) throw new Corrupt();
  const sections = elements(head, segment.body, segment.end);
  const firstCluster = sections.findIndex((element) => element.id === EBML.cluster);
  const beforeClusters = firstCluster === -1 ? sections : sections.slice(0, firstCluster);
  const info = beforeClusters.find((element) => element.id === EBML.info);
  const tracks = beforeClusters.find((element) => element.id === EBML.tracks);
  if (info === undefined && tracks === undefined) throw new Corrupt();
  const entries = tracks === undefined ? [] : elements(head, tracks.body, tracks.end).filter((element) => element.id === EBML.trackEntry);
  const video = entries.map((entry) => webmTrack(head, entry)).find((track) => track.type === TRACK_VIDEO);
  return {
    durationS: info === undefined ? null : webmDuration(head, info),
    width: video?.width ?? null,
    height: video?.height ?? null,
    audio: tracks === undefined ? null : entries.some((entry) => webmTrack(head, entry).type === TRACK_AUDIO),
  };
}

function webmDuration(head: Buffer, info: Element): number | null {
  const fields = elements(head, info.body, info.end);
  const scale = uintOf(head, fields.find((element) => element.id === EBML.timecodeScale)) ?? 1_000_000;
  const duration = fields.find((element) => element.id === EBML.duration);
  const length = duration === undefined ? 0 : duration.end - duration.body;
  if (duration === undefined || (length !== 4 && length !== 8)) return null;
  const ticks = length === 4 ? head.readFloatBE(duration.body) : head.readDoubleBE(duration.body);
  return Number.isFinite(ticks) && ticks >= 0 ? roundMs((ticks * scale) / 1e9) : null;
}

function webmTrack(head: Buffer, entry: Element): { type: number | null; width: number | null; height: number | null } {
  const fields = elements(head, entry.body, entry.end);
  const video = fields.find((element) => element.id === EBML.video);
  const frame = video === undefined ? [] : elements(head, video.body, video.end);
  const dimension = (id: number) => uintOf(head, frame.find((element) => element.id === id)) || null;
  return { type: uintOf(head, fields.find((element) => element.id === EBML.trackType)), width: dimension(EBML.pixelWidth), height: dimension(EBML.pixelHeight) };
}

function uintOf(head: Buffer, element: Element | undefined): number | null {
  const length = element === undefined ? 0 : element.end - element.body;
  return element === undefined || length < 1 || length > 6 ? null : head.readUIntBE(element.body, length);
}
