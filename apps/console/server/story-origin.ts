/**
 * The story origin's routes (TP-3793). The daemon serves them on a port of their own (`storyPort`),
 * so a round's Storybook build, which is PR-head code, runs in an origin that is not the console's:
 * it cannot read the console's pages, and the console's guards refuse its `Origin` on every write.
 *
 * - `GET /sb/<buildId>/<path>` serves a file of a build in the console's store, read-only and
 *   contained by `@titan-design/daemon`'s `containedFile`. The build's top `iframe.html` gets the
 *   bridge script injected before `</head>`; every other file goes out byte for byte.
 * - A build that is not in the store, or a file it lacks, gets a small fast-fail page whose bridge
 *   posts `error` at once, so the frame falls back to its PNG without waiting out a timeout.
 * - `GET /__bridge.js` serves the bridge.
 *
 * Every response here carries the story CSP. Origin isolation is what protects the console; the CSP
 * limits what a story can reach (no outside host for scripts, fetches, images or fonts) and pins
 * which pages may frame it.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { containedFile, fileResponse, type mountStaticApp } from "@titan-design/daemon";
import { BRIDGE_ERROR_ATTRIBUTE, BRIDGE_PATH, bridgeScript } from "./story-bridge.js";
import { BUILD_ID, IFRAME_FILE } from "./storybook-build.js";

type DaemonApp = Parameters<typeof mountStaticApp>[0];

interface StoryRoutesOptions {
  storybooksDir: string;
  /** The console page's own origins, read per request: the only frame ancestors and the bridge's only targets. */
  consoleOrigins: () => readonly string[];
}

const STORY_PREFIX = "/sb/";
const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
/** A build's id is the hash of its bytes, so a file under it never changes. */
const IMMUTABLE = "private, max-age=31536000, immutable";
const NO_CACHE = "private, no-cache";
const HEAD_CLOSE = /<\/head>/i;

/**
 * Scripts: `'self'` plus the hash of each inline script the served document carries. Storybook's
 * static `iframe.html` boots from three inline scripts, and a prebuilt file can carry no nonce, so
 * hashing them is what keeps `'unsafe-inline'` out. Styles do need `'unsafe-inline'`: Storybook and
 * a story's CSS-in-JS insert `<style>` elements at run time, and CSS can reach no other host here.
 */
function storyCsp(consoleOrigins: readonly string[], inlineScripts: readonly string[] = []): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inlineScripts.map(scriptHashSource)].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${consoleOrigins.length > 0 ? consoleOrigins.join(" ") : "'none'"}`,
  ].join("; ");
}

/** HEAD rides on GET. Nothing else is mounted: the content origin refuses every other method itself. */
export function mountStoryRoutes(app: DaemonApp, options: StoryRoutesOptions): void {
  app.get(BRIDGE_PATH, () => storyResponse(bridgeScript(options.consoleOrigins()), { status: 200, type: JS, cache: NO_CACHE }, options));
  app.get(`${STORY_PREFIX}*`, (c) => serveStoryFile(c.req.raw, options));
}

async function serveStoryFile(request: Request, options: StoryRoutesOptions): Promise<Response> {
  // Still percent-encoded: `containedFile` decodes each segment itself and refuses what could escape.
  const [buildId = "", ...rest] = new URL(request.url).pathname.slice(STORY_PREFIX.length).split("/");
  const root = await storedBuildDir(options.storybooksDir, buildId);
  if (root === null) return fastFail("the build is not in the console's store", options);
  const found = await containedFile(root, rest.join("/"));
  if (found.kind === "refused") return storyResponse("Refused", { status: 400, type: "text/plain; charset=utf-8", cache: NO_CACHE }, options);
  if (found.kind === "missing") return fastFail("the build has no such file", options);
  if (found.file === path.join(root, IFRAME_FILE)) return storyHost(found.file, options);
  const response = await fileResponse(request, found.file, { contentType: found.contentType, cacheControl: IMMUTABLE });
  return withStoryHeaders(response, options);
}

/** The real directory of a stored build, or null: a malformed id, an absent build, or a symlink in the store. */
async function storedBuildDir(storybooksDir: string, buildId: string): Promise<string | null> {
  if (!BUILD_ID.test(buildId)) return null;
  const dir = path.join(storybooksDir, buildId);
  const held = await lstat(dir).catch(() => null);
  if (held?.isDirectory() !== true) return null;
  return realpath(dir).catch(() => null);
}

/** The build's story host page with the bridge as the last script in its head, ahead of Storybook's deferred modules. */
async function storyHost(file: string, options: StoryRoutesOptions): Promise<Response> {
  const html = await readFile(file, "utf8").catch(() => null);
  if (html === null || !HEAD_CLOSE.test(html)) return fastFail(`the build's ${IFRAME_FILE} has no </head>`, options);
  const injected = html.replace(HEAD_CLOSE, (close) => `<script src="${BRIDGE_PATH}"></script>${close}`);
  return storyResponse(injected, { status: 200, type: HTML, cache: NO_CACHE, inlineScripts: inlineScriptsOf(html) }, options);
}

const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTRIBUTE = /\bsrc\s*=/i;

/** The text of each script element with no `src`, exactly as the browser hashes it. */
function inlineScriptsOf(html: string): string[] {
  return [...html.matchAll(SCRIPT_ELEMENT)].flatMap(([, attributes = "", text = ""]) => (SRC_ATTRIBUTE.test(attributes) ? [] : [text]));
}

const scriptHashSource = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

function fastFail(reason: string, options: StoryRoutesOptions): Response {
  const text = escapeHtml(reason);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Live story unavailable</title><script src="${BRIDGE_PATH}" ${BRIDGE_ERROR_ATTRIBUTE}="${text}"></script></head><body><p>Live story unavailable: ${text}</p></body></html>`;
  return storyResponse(html, { status: 404, type: HTML, cache: NO_CACHE }, options);
}

interface ResponseShape {
  status: number;
  type: string;
  cache: string;
  /** The document's own inline scripts, each allowed by its hash. */
  inlineScripts?: readonly string[];
}

function storyResponse(body: string, { status, type, cache, inlineScripts }: ResponseShape, options: StoryRoutesOptions): Response {
  return withStoryHeaders(new Response(body, { status, headers: { "content-type": type, "cache-control": cache } }), options, inlineScripts);
}

function withStoryHeaders(response: Response, options: StoryRoutesOptions, inlineScripts: readonly string[] = []): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", storyCsp(options.consoleOrigins(), inlineScripts));
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
