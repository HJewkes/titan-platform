import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fileResponse, type mountStaticApp } from "@titan-design/daemon";
import { readCommand } from "./owner-guard.js";
import { deriveFields, foldCopies, readFolderDocs, type Derived, type FolderDocs } from "./video-derived.js";
import { posterContentType, posterNames } from "./video-poster.js";
import { resolveVideo } from "./video-resolve.js";
import { mediaFields, mediaOf, UNKNOWN_MEDIA, type Media } from "./video-media.js";
import { mergeMeta, metaGaps, readFolderMeta, readVideoMeta, sidecarName, VIDEO_FOLDER_MANIFEST, videoMeta, type FolderMeta } from "./video-meta.js";

type DaemonApp = Parameters<typeof mountStaticApp>[0];

const MAX_DEPTH = 8;
const MAX_VIDEOS = 2000;
const CATALOG_TTL_MS = 30_000;
const SKIPPED_DIRS = new Set(["node_modules", "archive"]);
const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };
const CAPTIONS_TYPE = "text/vtt; charset=utf-8";
const VIDEO_ID = /^v_[0-9a-f]{20}$/;
/** Fixed so a refusal never tells the client whether, or where, a file exists. */
const NOT_FOUND = "Video not found";
export const ROOTS_UNSET = "TITAN_CONSOLE_VIDEO_ROOTS is not set";

/** The sidecar's fields come first so the row's own `title` stays required. */
const videoEntry = z.object({
  ...videoMeta.shape,
  id: z.string(),
  title: z.string(),
  group: z.string(),
  bytes: z.number().int(),
  modifiedAt: z.string(),
  captions: z.boolean(),
  renderNotes: z.boolean(),
  ...mediaFields,
  /** How many identical files under `copies` or `intermediate` folders were folded into this row. */
  copies: z.number().int(),
  /** The sidecar's `status` when it has one, else whether a later take of the same series sits beside it. */
  superseded: z.boolean(),
});

type VideoEntry = z.infer<typeof videoEntry>;

/** The owner's call on one render, from the theater's Ship and Needs changes buttons. */
export const verdict = z.enum(["ship", "needs-changes"]);

/** `openNoteCount` is the agent pickup rule's count: comments on this render made after its latest Ship. */
const noteSummary = z.object({ noteCount: z.number().int(), openNoteCount: z.number().int(), verdict: verdict.nullable() });

/** What the notes beside one video say about its current render; the file is the video's real path. */
export type NoteSummarizer = (file: string) => Promise<z.infer<typeof noteSummary>>;

/** One of the two lookups: `alias` alone, or any of the filters, at least one. */
const resolveArgs = z
  .strictObject({
    series: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    alias: z.string().min(1).optional(),
  })
  .refine(({ alias, ...filters }) => (alias === undefined ? Object.keys(filters).length > 0 : Object.keys(filters).length === 0), {
    message: "Give an alias alone, or at least one of series, tag and subject",
  });

const NO_NOTES = { noteCount: 0, openNoteCount: 0, verdict: null } as const;

/** Where one listed video sits; server-side only, so the client names a video by id and never by path. */
interface Located {
  realRoot: string;
  relative: string;
}

interface Catalog {
  videos: VideoEntry[];
  truncated: boolean;
  gaps: string[];
  located: Map<string, Located>;
}

/** Counted during a walk, then folded into one gap line each. */
interface Unreadable {
  sidecars: number;
  manifests: number;
  headers: number;
}

/** One video as the walk found it, before copies fold and the derived fields, which compare siblings, are filled. */
interface Draft {
  id: string;
  file: string;
  relative: string;
  info: Stats;
  group: string;
  stem: string;
  modifiedAt: string;
  meta: z.infer<typeof videoMeta>;
  docs: FolderDocs;
  media: Media;
  captions: boolean;
  renderNotes: boolean;
}

interface Scan {
  catalog: Catalog;
  unreadable: Unreadable;
  drafts: Draft[];
}

export interface VideoCatalog {
  /** Rescans the roots now; the media routes then resolve every id this returned. */
  refresh(): Promise<Catalog>;
  /** The last scan while it is under 30 s old, else a fresh one. */
  current(): Promise<Catalog>;
}

interface VideoCatalogOptions {
  roots: readonly string[];
  now?: () => number;
}

/** `v_` plus 20 hex of sha256 over the real root and the relative path, so an id is stable across scans and opaque. */
export function videoId(realRoot: string, relative: string): string {
  return `v_${createHash("sha256").update(`${realRoot}\0${relative}`).digest("hex").slice(0, 20)}`;
}

export function videoCatalog({ roots, now = Date.now }: VideoCatalogOptions): VideoCatalog {
  let cached: { at: number; scan: Promise<Catalog> } | null = null;
  const refresh = (): Promise<Catalog> => {
    const scan = scanVideos(roots);
    cached = { at: now(), scan };
    scan.catch(() => (cached = null));
    return scan;
  };
  return {
    refresh,
    current: () => (cached !== null && now() - cached.at < CATALOG_TTL_MS ? cached.scan : refresh()),
  };
}

/** Every mp4 and webm under the roots' real paths, newest first, skipping dot-dirs, `node_modules`, `archive` and symlinks. */
export async function scanVideos(roots: readonly string[]): Promise<Catalog> {
  const catalog: Catalog = { videos: [], truncated: false, gaps: roots.length === 0 ? [ROOTS_UNSET] : [], located: new Map() };
  const scan: Scan = { catalog, unreadable: { sidecars: 0, manifests: 0, headers: 0 }, drafts: [] };
  for (const [index, root] of roots.entries()) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot === null) catalog.gaps.push(`Video root ${index + 1} of ${roots.length} cannot be read`);
    else await walk(scan, realRoot, realRoot, 0);
  }
  const { sidecars, manifests, headers } = scan.unreadable;
  catalog.gaps.push(...metaGaps(sidecars, manifests), ...(headers > 0 ? [`${headers} video header${headers === 1 ? "" : "s"} could not be read`] : []));
  catalog.videos = await finish(scan.drafts);
  catalog.videos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return catalog;
}

async function walk(scan: Scan, realRoot: string, dir: string, depth: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const names = new Set(entries.map((entry) => entry.name));
  const isVideo = (entry: Dirent) => entry.isFile() && path.extname(entry.name).toLowerCase() in VIDEO_TYPES;
  const hasVideos = entries.some((entry) => !entry.name.startsWith(".") && isVideo(entry));
  const folder = await folderMetaOf(dir, names, hasVideos, scan.unreadable);
  const docs = hasVideos ? await readFolderDocs(dir, names) : {};
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) await walk(scan, realRoot, path.join(dir, entry.name), depth + 1);
    else if (isVideo(entry)) await add(scan, { realRoot, folder, docs, siblings: names }, path.join(dir, entry.name));
  }
}

/** Read only where a manifest sits beside at least one video, so folders without one cost nothing. */
async function folderMetaOf(dir: string, names: ReadonlySet<string>, hasVideos: boolean, unreadable: Unreadable): Promise<FolderMeta> {
  if (!hasVideos || !names.has(VIDEO_FOLDER_MANIFEST)) return null;
  const folder = await readFolderMeta(dir);
  if (folder === "unreadable") unreadable.manifests++;
  return folder;
}

interface FolderContext {
  realRoot: string;
  folder: FolderMeta;
  docs: FolderDocs;
  siblings: ReadonlySet<string>;
}

async function add({ catalog, unreadable, drafts }: Scan, { realRoot, folder, docs, siblings }: FolderContext, file: string): Promise<void> {
  if (drafts.length >= MAX_VIDEOS) {
    catalog.truncated = true;
    return;
  }
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return;
  const relative = path.relative(realRoot, file);
  const id = videoId(realRoot, relative);
  const name = path.basename(file);
  const own = siblings.has(sidecarName(name)) ? await readVideoMeta(file) : null;
  if (own === "unreadable") unreadable.sidecars++;
  const media = await mediaOf(file, info);
  if (media === "unreadable") unreadable.headers++;
  catalog.located.set(id, { realRoot, relative });
  drafts.push({
    id,
    file,
    relative,
    info,
    group: groupOf(realRoot, relative),
    stem: path.parse(name).name,
    modifiedAt: info.mtime.toISOString(),
    meta: mergeMeta(folder, name, own === "unreadable" ? null : own),
    docs,
    media: media === "unreadable" ? UNKNOWN_MEDIA : media,
    captions: siblings.has(captionsName(name)),
    renderNotes: siblings.has("render-notes.md"),
  });
}

/** Folded copies stay in `located`, so an id listed before a copy appeared still resolves. */
async function finish(drafts: readonly Draft[]): Promise<VideoEntry[]> {
  const kept = await foldCopies(drafts);
  const derived = deriveFields(kept.map(({ row }) => row));
  return kept.map(({ row, copies }, index) => entryOf(row, derived[index]!, copies));
}

function entryOf({ id, group, info, modifiedAt, meta, media, captions, renderNotes }: Draft, derived: Derived, copies: number): VideoEntry {
  return { ...meta, ...derived, id, group, bytes: info.size, modifiedAt, captions, renderNotes, ...media, copies };
}

/** The root's own name, then the relative directory: names the initiative a render belongs to, never an absolute path. */
function groupOf(realRoot: string, relative: string): string {
  return [path.basename(realRoot), ...path.dirname(relative).split(path.sep).filter((segment) => segment !== ".")].join("/");
}

function captionsName(videoName: string): string {
  return `${path.parse(videoName).name}.vtt`;
}

/** One at a time, so a catalog of 2000 videos never holds 2000 file handles open at once. */
async function withNotes({ videos, located }: Catalog, summarize: NoteSummarizer) {
  const listed = [];
  for (const video of videos) {
    const file = await containedFile(located.get(video.id)!);
    listed.push({ ...video, ...(file === null ? NO_NOTES : await summarize(file)) });
  }
  return listed;
}

export function videosCommands(catalog: VideoCatalog = videoCatalog({ roots: [] }), summarize: NoteSummarizer = async () => NO_NOTES) {
  return {
    "videos.list": readCommand({
      name: "videos.list",
      description: "Every mp4 and webm under TITAN_CONSOLE_VIDEO_ROOTS, newest first, with whether captions and render notes sit beside it, and the current render's note count and verdict",
      args: z.object({}),
      result: z.object({ videos: z.array(videoEntry.extend(noteSummary.shape)), truncated: z.boolean(), gaps: z.array(z.string()) }),
      run: async () => {
        const scan = await catalog.refresh();
        return { videos: await withNotes(scan, summarize), truncated: scan.truncated, gaps: scan.gaps };
      },
    }),
    "videos.resolve": readCommand({
      name: "videos.resolve",
      description: "The newest non-superseded video matching a series, tag and subject, or the video an alias names; the result says when nothing matches",
      args: resolveArgs,
      result: z.discriminatedUnion("found", [z.object({ found: z.literal(true), id: z.string() }), z.object({ found: z.literal(false), reason: z.string() })]),
      run: async (args) => resolveVideo((await catalog.current()).videos, args),
    }),
  };
}

/** The real path of a listed video, re-checked inside its root; null for an unknown id or one that now leads out. */
export async function locateVideo(catalog: VideoCatalog, id: string): Promise<string | null> {
  if (!VIDEO_ID.test(id)) return null;
  const located = (await catalog.current()).located.get(id);
  return located === undefined ? null : containedFile(located);
}

function containedFile({ realRoot, relative }: Located): Promise<string | null> {
  return containedRealPath(realRoot, relative);
}

/**
 * `GET /media/videos/:id`, `/captions` and `/poster`, ahead of the static app, whose `/*`
 * would answer a missing asset with 404. HEAD rides on GET. The daemon's auth gate covers both.
 */
export function mountVideoMedia(app: DaemonApp, catalog: VideoCatalog): void {
  app.get("/media/videos/:id", async (c) => serve(c.req.raw, catalog, c.req.param("id"), "video"));
  app.get("/media/videos/:id/captions", async (c) => serve(c.req.raw, catalog, c.req.param("id"), "captions"));
  app.get("/media/videos/:id/poster", async (c) => servePoster(c.req.raw, catalog, c.req.param("id")));
}

/** The sidecar's poster, then `<stem>-poster.jpg`, then `.png`; contact sheets are never candidates. */
export async function servePoster(request: Request, catalog: VideoCatalog, id: string): Promise<Response> {
  if (!VIDEO_ID.test(id)) return notFound();
  const current = await catalog.current();
  const located = current.located.get(id);
  if (located === undefined) return notFound();
  const sidecarPoster = current.videos.find((video) => video.id === id)?.poster;
  const dir = path.dirname(located.relative);
  for (const name of posterNames(path.basename(located.relative), sidecarPoster)) {
    const file = await containedPlainFile(located.realRoot, path.join(dir, name));
    if (file === null) continue;
    const response = await fileResponse(request, file, { contentType: posterContentType(file), cacheControl: "private, no-cache" });
    return response.status === 403 || response.status === 404 ? notFound() : response;
  }
  return notFound();
}

/** Like `containedRealPath`, but a symlink at the leaf or a non-regular file is refused outright. */
async function containedPlainFile(realRoot: string, relative: string): Promise<string | null> {
  const info = await lstat(path.join(realRoot, relative)).catch(() => null);
  return info?.isFile() === true ? containedRealPath(realRoot, relative) : null;
}

async function serve(request: Request, catalog: VideoCatalog, id: string, part: "video" | "captions"): Promise<Response> {
  if (!VIDEO_ID.test(id)) return notFound();
  const located = (await catalog.current()).located.get(id);
  if (located === undefined) return notFound();
  const relative = part === "video" ? located.relative : path.join(path.dirname(located.relative), captionsName(path.basename(located.relative)));
  const file = await containedRealPath(located.realRoot, relative);
  if (file === null) return notFound();
  const contentType = part === "video" ? VIDEO_TYPES[path.extname(file).toLowerCase()] : path.extname(file) === ".vtt" ? CAPTIONS_TYPE : undefined;
  if (contentType === undefined) return notFound();
  const response = await fileResponse(request, file, { contentType, cacheControl: "private, no-cache" });
  return response.status === 403 || response.status === 404 ? notFound() : response;
}

/** Re-checked per request: a file swapped for a symlink since the scan must not lead out of its root. */
async function containedRealPath(realRoot: string, relative: string): Promise<string | null> {
  const real = await realpath(path.join(realRoot, relative)).catch(() => null);
  if (real === null) return null;
  const inside = path.relative(realRoot, real);
  return inside.startsWith("..") || path.isAbsolute(inside) ? null : real;
}

function notFound(): Response {
  return new Response(NOT_FOUND, { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
}
