/**
 * `rounds.clip` and `rounds.audio`: `GET /media/rounds/:id/clip/:key` and `/media/rounds/:id/audio/:key` serve the
 * recorded clip or sound a round's variant declares, with HTTP byte ranges so the page can seek. The client names a
 * round and a variant key, never a path; the path is the variant's own `clip` or `audio` in `round.json`.
 *
 * Guarded as `rounds.frame` guards a PNG: the path stays inside the round dir, every directory below it is lstat'd so
 * none is a symlink, and the file itself is regular, never a symlink or a FIFO. Every refusal is one fixed 404 that
 * names no path. Only a variant's own `audio` is served: a blind-ab round never parses (`round-schema.ts`), so none of
 * its takes, whose engines the page must not learn, is reachable.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileResponse, type mountStaticApp } from "@titan-design/daemon";
import { assertRealDirs } from "./round-frames.js";
import { readManifest, roundDirExists, type RoundsSource } from "./rounds.js";

type DaemonApp = Parameters<typeof mountStaticApp>[0];

export type RoundMediaKind = "clip" | "audio";

const VARIANT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_TYPES: Record<RoundMediaKind, Record<string, string>> = {
  clip: { ".mp4": "video/mp4", ".webm": "video/webm" },
  audio: { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4" },
};
const NOT_FOUND = "Round media not found";

/** The real file a variant declares, or null when the key, the round or the path fails any check. */
async function declaredFile({ dir }: RoundsSource, id: string, key: string, kind: RoundMediaKind): Promise<string | null> {
  if (!VARIANT_KEY.test(key) || !(await roundDirExists(dir, id))) return null;
  const roundDir = path.resolve(dir, id);
  const { parsed } = await readManifest(roundDir);
  if (!parsed.ok) return null;
  const declared = parsed.manifest.variants.find((variant) => variant.key === key)?.[kind];
  return declared === undefined ? null : containedFile(roundDir, declared);
}

/** A leaf lstat before the open, because the shared range reader opens without O_NONBLOCK and a FIFO would hang it. */
async function containedFile(roundDir: string, relative: string): Promise<string | null> {
  const full = path.resolve(roundDir, relative);
  if (!full.startsWith(roundDir + path.sep)) return null;
  const realDirs = await assertRealDirs(roundDir, path.relative(roundDir, full).split(path.sep)).then(
    () => true,
    () => false,
  );
  if (!realDirs) return null;
  const leaf = await lstat(full).catch(() => null);
  return leaf?.isFile() === true ? full : null;
}

/** One variant's clip or sound, whole or as the byte range the request asks for. */
export async function serveRoundMedia(request: Request, source: RoundsSource, id: string, key: string, kind: RoundMediaKind): Promise<Response> {
  const file = await declaredFile(source, id, key, kind);
  const contentType = file === null ? undefined : MEDIA_TYPES[kind][path.extname(file).toLowerCase()];
  if (file === null || contentType === undefined) return notFound();
  const response = await fileResponse(request, file, { contentType, cacheControl: "private, no-cache" });
  return response.status === 403 || response.status === 404 ? notFound() : response;
}

/** Mounted ahead of the static app, whose `/*` would answer a media request with the page. HEAD rides on GET. */
export function mountRoundMedia(app: DaemonApp, source: RoundsSource): void {
  app.get("/media/rounds/:id/clip/:key", (c) => serveRoundMedia(c.req.raw, source, c.req.param("id"), c.req.param("key"), "clip"));
  app.get("/media/rounds/:id/audio/:key", (c) => serveRoundMedia(c.req.raw, source, c.req.param("id"), c.req.param("key"), "audio"));
}

function notFound(): Response {
  return new Response(NOT_FOUND, { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
}
