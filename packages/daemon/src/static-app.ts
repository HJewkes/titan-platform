/**
 * Serves a built front end through the `mountRoutes` seam. Registered after the daemon's
 * own routes and behind its guards, so it can neither shadow `/rpc` nor skip the Host check.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { contentType, existingFile, isFile, requestSegments } from "./contained-file.js";

export interface StaticAppOptions {
  /** A built app directory holding `index.html`, or a single-file build's HTML file. */
  root: string;
  /** URL prefix the app lives under, such as `/ui`. Defaults to `/`. */
  base?: string;
  /** Directory under `root` whose files carry content hashes and never change. Defaults to `assets`. */
  immutableDir?: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

const NOT_BUILT_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not built</title></head>' +
  "<body><h1>This app has not been built</h1><p>The daemon is running; build the front end and reload.</p></body></html>";

type Resolution =
  | { kind: "file"; file: string; immutable: boolean }
  | { kind: "index"; file: string }
  | { kind: "refused" }
  | { kind: "missing" }
  | { kind: "unbuilt" };

/** Mounts `GET <base>/*`: files from `root`, `index.html` for client routes, 404 for missing assets. */
export function mountStaticApp(app: Hono, options: StaticAppOptions): void {
  const base = (options.base ?? "/").replace(/\/+$/, "");
  const immutableDir = options.immutableDir ?? "assets";
  if (base) app.get(base, (c) => c.redirect(`${base}/${new URL(c.req.url).search}`, 308));
  app.get(`${base}/*`, async (c) => {
    // Load-bearing: new URL folds . and .. (even single-encoded %2e) first; requestSegments then stops ..%2f, ..%5c, and NUL.
    const segments = requestSegments(new URL(c.req.url).pathname.slice(base.length));
    const found = segments ? await resolveRequest(options.root, segments, immutableDir) : ({ kind: "refused" } as const);
    return respond(c, found);
  });
}

async function resolveRequest(root: string, segments: string[], immutableDir: string): Promise<Resolution> {
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return { kind: "unbuilt" };
  const rootIsFile = (await stat(realRoot)).isFile();
  const index = rootIsFile ? realRoot : path.join(realRoot, "index.html");
  if (segments.length > 0 && !rootIsFile) {
    const found = await existingFile(realRoot, segments);
    if (found === "refused") return { kind: "refused" };
    if (found !== "missing") return { kind: "file", file: found, immutable: segments[0] === immutableDir };
  }
  // A path with an extension is a missing asset; answering it with HTML would hide the error.
  if (segments.length > 0 && path.extname(segments.at(-1)!) !== "") return { kind: "missing" };
  return (await isFile(index)) ? { kind: "index", file: index } : { kind: "unbuilt" };
}

async function respond(c: Context, found: Resolution): Promise<Response> {
  c.header("x-content-type-options", "nosniff");
  if (found.kind === "refused") return c.text("Forbidden", 403);
  if (found.kind === "missing") return c.text("Not found", 404);
  if (found.kind === "unbuilt") return c.html(NOT_BUILT_HTML, 503, { "cache-control": REVALIDATE });
  const body = new Uint8Array(await readFile(found.file));
  const type = found.kind === "index" ? contentType("index.html") : contentType(found.file);
  const cache = found.kind === "file" && found.immutable ? IMMUTABLE : REVALIDATE;
  return c.body(body, 200, { "content-type": type, "cache-control": cache });
}
