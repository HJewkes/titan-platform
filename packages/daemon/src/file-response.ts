/**
 * Answers a request for one file with HTTP byte-range support, so a browser can seek in media.
 * The caller resolves the path and checks containment; this module only guards the final open.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

export interface FileResponseOptions {
  contentType: string;
  /** Sent as `Cache-Control` when set. */
  cacheControl?: string;
}

type RangeRequest =
  | { kind: "whole" }
  | { kind: "unsatisfiable" }
  | { kind: "slice"; start: number; end: number };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Serves `file` for a GET or HEAD `request`. `file` must be an already-resolved real path inside
 * a directory the caller chose to expose: containment is the caller's job, and the client must
 * never name the path. A symlink at the final component or a non-regular file is refused (403),
 * a missing file is 404.
 */
export async function fileResponse(
  request: Request,
  file: string,
  options: FileResponseOptions
): Promise<Response> {
  const handle = await openRegular(file);
  if (handle === "missing") return plain("Not found", 404);
  if (handle === "refused") return plain("Forbidden", 403);
  const { size } = await handle.stat();
  const range = parseRange(request.headers.get("range"), size);
  const headers = baseHeaders(options);
  if (range.kind === "unsatisfiable") {
    await handle.close();
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end, status] =
    range.kind === "slice" ? [range.start, range.end, 206] : [0, size - 1, 200];
  const length = size === 0 ? 0 : end - start + 1;
  headers.set("content-length", String(length));
  if (status === 206)
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  if (request.method === "HEAD" || length === 0) {
    await handle.close();
    return new Response(null, { status, headers });
  }
  return new Response(streamRange(handle, start, end), { status, headers });
}

async function openRegular(
  file: string
): Promise<FileHandle | "missing" | "refused"> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "refused";
  }
  if ((await handle.stat()).isFile()) return handle;
  await handle.close();
  return "refused";
}

/** `whole` for no header, a malformed one, or several ranges (the spec lets a server ignore those). */
function parseRange(header: string | null, size: number): RangeRequest {
  const match = header === null ? null : SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: "whole" };
  const from = match[1] ?? "";
  const to = match[2] ?? "";
  if (from === "" && to === "") return { kind: "whole" };
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "slice", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (to !== "" && Number(to) < start) return { kind: "whole" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "slice", start, end };
}

function streamRange(
  handle: FileHandle,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    handle.createReadStream({ start, end, autoClose: true })
  ) as ReadableStream<Uint8Array>;
}

function baseHeaders(options: FileResponseOptions): Headers {
  const headers = new Headers({
    "content-type": options.contentType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  if (options.cacheControl !== undefined)
    headers.set("cache-control", options.cacheControl);
  return headers;
}

function plain(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
