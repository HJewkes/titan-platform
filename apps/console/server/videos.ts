import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fileResponse, type mountStaticApp } from "@titan-design/daemon";
import { readCommand } from "./owner-guard.js";

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

const videoEntry = z.object({
  id: z.string(),
  title: z.string(),
  group: z.string(),
  bytes: z.number().int(),
  modifiedAt: z.string(),
  captions: z.boolean(),
  renderNotes: z.boolean(),
});

type VideoEntry = z.infer<typeof videoEntry>;

/** The owner's call on one render, from the theater's Ship and Needs changes buttons. */
export const verdict = z.enum(["ship", "needs-changes"]);

const noteSummary = z.object({ noteCount: z.number().int(), verdict: verdict.nullable() });

/** What the notes beside one video say about its current render; the file is the video's real path. */
export type NoteSummarizer = (file: string) => Promise<z.infer<typeof noteSummary>>;

const NO_NOTES = { noteCount: 0, verdict: null } as const;

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
  for (const [index, root] of roots.entries()) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot === null) catalog.gaps.push(`Video root ${index + 1} of ${roots.length} cannot be read`);
    else await walk(catalog, realRoot, realRoot, 0);
  }
  catalog.videos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return catalog;
}

async function walk(catalog: Catalog, realRoot: string, dir: string, depth: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) await walk(catalog, realRoot, path.join(dir, entry.name), depth + 1);
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() in VIDEO_TYPES) await add(catalog, realRoot, path.join(dir, entry.name), names);
  }
}

async function add(catalog: Catalog, realRoot: string, file: string, siblings: ReadonlySet<string>): Promise<void> {
  if (catalog.videos.length >= MAX_VIDEOS) {
    catalog.truncated = true;
    return;
  }
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return;
  const relative = path.relative(realRoot, file);
  const id = videoId(realRoot, relative);
  const name = path.basename(file);
  catalog.located.set(id, { realRoot, relative });
  catalog.videos.push({
    id,
    title: path.parse(name).name,
    group: groupOf(realRoot, relative),
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    captions: siblings.has(captionsName(name)),
    renderNotes: siblings.has("render-notes.md"),
  });
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
 * `GET /media/videos/:id` and `/media/videos/:id/captions`, ahead of the static app, whose `/*`
 * would answer a missing asset with 404. HEAD rides on GET. The daemon's auth gate covers both.
 */
export function mountVideoMedia(app: DaemonApp, catalog: VideoCatalog): void {
  app.get("/media/videos/:id", async (c) => serve(c.req.raw, catalog, c.req.param("id"), "video"));
  app.get("/media/videos/:id/captions", async (c) => serve(c.req.raw, catalog, c.req.param("id"), "captions"));
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
