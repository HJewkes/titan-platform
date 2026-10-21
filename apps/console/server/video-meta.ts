/**
 * What agents say about a render, so the theater reads purpose, subject and poster time from data
 * rather than guessing them from paths. Two files feed it, both written by agents and only read here:
 * a `titan-console/video-meta@1` sidecar, `<stem>.video.json` beside the video, and a
 * `titan-console/video-folder@1` manifest, `_videos.json`, that covers a batch of clips in one folder.
 * A sidecar field beats the manifest's item for that file, which beats the manifest's folder default.
 *
 * A file that cannot be read or parsed is counted, never thrown, so one bad sidecar costs a gap
 * line and not the list. Parsed files are cached by what identifies their bytes, as the sha cache
 * does, because `videos.list` rescans on every request.
 */
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OPEN_FLAGS, readCapped } from "./rounds.js";

export const VIDEO_META_SCHEMA = "titan-console/video-meta@1";
export const VIDEO_FOLDER_SCHEMA = "titan-console/video-folder@1";
export const VIDEO_FOLDER_MANIFEST = "_videos.json";
export const MAX_META_BYTES = 64 * 1024;
const MAX_CACHED_META = 4096;

const label = z.string().trim().min(1).max(200);

const folderFields = {
  description: z.string().trim().min(1).max(2000).optional(),
  purpose: z.enum(["daily", "repo-review", "plan", "design", "explainer", "test", "clip"]).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  subject: z.strictObject({ kind: z.enum(["repo", "day", "initiative"]), id: label }).optional(),
  /** The id or alias of the video a clip was cut from. */
  parent: label.optional(),
  posterAtS: z.number().min(0).optional(),
  series: label.optional(),
  take: label.optional(),
  status: z.enum(["draft", "review", "final", "superseded"]).optional(),
};

const videoFields = {
  ...folderFields,
  title: label.optional(),
  /** Stable across a file move, unlike the id, which hashes the path. */
  alias: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).optional(),
  /** A jpg or png beside the video, by file name only, so a sidecar can never name a path elsewhere. */
  poster: z.string().regex(/^[^/\\\0]{1,200}\.(?:jpe?g|png)$/i).optional(),
};

/** The fields one video carries; also what `videos.list` adds to a row. */
export const videoMeta = z.strictObject(videoFields);
type VideoMeta = z.infer<typeof videoMeta>;

/** Non-strict, so parsing a checked file through it drops `schema` and keeps the rest. */
const metaOnly = z.object(videoFields);
const folderDefaults = z.object(folderFields);

const sidecar = z.strictObject({ schema: z.literal(VIDEO_META_SCHEMA), ...videoFields }).transform((file) => metaOnly.parse(file));
const folderManifest = z
  .strictObject({ schema: z.literal(VIDEO_FOLDER_SCHEMA), ...folderFields, items: z.record(z.string().min(1), videoMeta).optional() })
  .transform((file) => ({ defaults: folderDefaults.parse(file), items: file.items ?? {} }));

type FolderManifest = z.infer<typeof folderManifest>;

/** What a scan learned about one folder: a parsed manifest, none, or one it could not read. */
export type FolderMeta = FolderManifest | null | "unreadable";

export function sidecarName(videoName: string): string {
  return `${path.parse(videoName).name}.video.json`;
}

type Parsed<T> = T | "unreadable";

/** One cache per schema, so a cached value always has that schema's type. */
interface Reader<T> {
  schema: z.ZodType<T>;
  cache: Map<string, Parsed<T>>;
}

const videoReader: Reader<VideoMeta> = { schema: sidecar, cache: new Map() };
const folderReader: Reader<FolderManifest> = { schema: folderManifest, cache: new Map() };

/** Null for a missing file; "unreadable" for one that is not a regular file, too big, or not valid. */
async function readParsed<T>({ schema, cache }: Reader<T>, file: string): Promise<Parsed<T> | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? null : "unreadable";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "unreadable";
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const bytes = await readCapped(handle, MAX_META_BYTES);
    const parsed = bytes === null ? undefined : schema.safeParse(parseJson(bytes.toString("utf8")));
    return remember(cache, key, parsed?.success === true ? parsed.data : "unreadable");
  } finally {
    await handle.close();
  }
}

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MAX_CACHED_META) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function readFolderMeta(dir: string): Promise<FolderMeta> {
  return readParsed(folderReader, path.join(dir, VIDEO_FOLDER_MANIFEST));
}

export function readVideoMeta(file: string): Promise<VideoMeta | null | "unreadable"> {
  return readParsed(videoReader, path.join(path.dirname(file), sidecarName(path.basename(file))));
}

/** Sidecar over the manifest's item for this file name over the manifest's folder defaults. */
export function mergeMeta(folder: FolderMeta, videoName: string, own: VideoMeta | null): VideoMeta {
  const manifest = folder === null || folder === "unreadable" ? null : folder;
  return { ...manifest?.defaults, ...manifest?.items[videoName], ...own };
}

export function metaGaps(unreadableSidecars: number, unreadableManifests: number): string[] {
  const line = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"} could not be read`;
  return [
    ...(unreadableSidecars > 0 ? [line(unreadableSidecars, "video sidecar")] : []),
    ...(unreadableManifests > 0 ? [line(unreadableManifests, "video folder manifest")] : []),
  ];
}
