/**
 * Resolves a request path to a real file under a root without ever leaving it. Shared by
 * `mountStaticApp`, which has one fixed root, and products that pick the root per request.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ContainedFile =
  | { kind: "file"; file: string; contentType: string }
  /** The path could name something outside the root, by encoding or by symlink. */
  | { kind: "refused" }
  /** No regular file there: absent, a directory, or a dotfile. */
  | { kind: "missing" };

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/**
 * The file `pathname` names under `root`. `pathname` is the still-encoded tail of a URL path
 * that has already been through `new URL`, which folds `.` and `..` (even single-encoded
 * `%2e`); what survives that, such as `..%2f`, is refused here. A directory, the root itself
 * included, is `missing`: nothing here lists a directory or picks an index file.
 */
export async function containedFile(root: string, pathname: string): Promise<ContainedFile> {
  const segments = requestSegments(pathname);
  if (!segments) return { kind: "refused" };
  if (segments.length === 0) return { kind: "missing" };
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return { kind: "missing" };
  const found = await existingFile(realRoot, segments);
  if (found === "refused" || found === "missing") return { kind: found };
  return { kind: "file", file: found, contentType: contentType(found) };
}

/**
 * Decoded path segments, or null for anything that could name a file outside the root:
 * `.` or `..`, an encoded slash or backslash, a NUL, a drive letter, or a malformed escape.
 */
export function requestSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || /[/\\\0]/.test(segment) || /^[a-z]:/i.test(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

/** The real file a request names, `refused` when a symlink leads outside the root, or `missing`. */
export async function existingFile(realRoot: string, segments: string[]): Promise<string | "refused" | "missing"> {
  // Dotfiles are never part of a build, and serving one could leak a stray `.env`.
  if (segments.some((segment) => segment.startsWith("."))) return "missing";
  const real = await realpath(path.join(realRoot, ...segments)).catch(() => null);
  if (!real) return "missing";
  const relative = path.relative(realRoot, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "refused";
  return (await isFile(real)) ? real : "missing";
}

export async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}

export function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
