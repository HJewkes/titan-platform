import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileResponse } from "./file-response.js";

let dir: string;
const BYTES = Buffer.from("0123456789abcdefghij");

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "file-response-"));
  await writeFile(path.join(dir, "clip.bin"), BYTES);
  await writeFile(path.join(dir, "empty.bin"), "");
  await mkdir(path.join(dir, "folder"));
  await symlink(path.join(dir, "clip.bin"), path.join(dir, "alias.bin"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function appFor(name: string) {
  const app = new Hono();
  app.on(["GET", "HEAD"], "/f", (c) =>
    fileResponse(c.req.raw, path.join(dir, name), {
      contentType: "video/mp4",
      cacheControl: "no-cache",
    }),
  );
  return app;
}

const fetchFile = (range?: string, init: RequestInit = {}, name = "clip.bin") =>
  appFor(name).request("/f", { ...init, headers: range ? { range } : {} });

describe("fileResponse", () => {
  it("answers bytes=0-1 with 206, two bytes and an inclusive Content-Range", async () => {
    const res = await fetchFile("bytes=0-1");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${BYTES.length}`);
    expect(res.headers.get("content-length")).toBe("2");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("01");
  });

  it("reads bytes=-4 as the last four bytes", async () => {
    const res = await fetchFile("bytes=-4");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 16-19/${BYTES.length}`);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("ghij");
  });

  it("reads an open-ended range to the end and clamps an end past the size", async () => {
    const open = await fetchFile("bytes=15-");
    expect(Buffer.from(await open.arrayBuffer()).toString()).toBe("fghij");
    const clamped = await fetchFile("bytes=18-999");
    expect(clamped.headers.get("content-range")).toBe(`bytes 18-19/${BYTES.length}`);
  });

  it("answers a start at or past the size with 416 and the size", async () => {
    const res = await fetchFile(`bytes=${BYTES.length}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BYTES.length}`);
  });

  it("answers a multi-range or malformed request with the whole file", async () => {
    for (const header of ["bytes=0-1,4-5", "bytes=5-2", "items=0-1", "bytes=-"]) {
      const res = await fetchFile(header);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
    }
  });

  it("sends Content-Length and no body for HEAD", async () => {
    const res = await fetchFile(undefined, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(BYTES.length));
    expect(await res.text()).toBe("");
  });

  it("always sets Accept-Ranges, nosniff, the type and the cache header", async () => {
    const res = await fetchFile();
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("refuses a symlink, a directory, and answers 404 for a missing file", async () => {
    expect((await fetchFile(undefined, {}, "alias.bin")).status).toBe(403);
    expect((await fetchFile(undefined, {}, "folder")).status).toBe(403);
    expect((await fetchFile(undefined, {}, "absent.bin")).status).toBe(404);
  });

  it("serves an empty file whole and refuses a range on it", async () => {
    expect((await fetchFile(undefined, {}, "empty.bin")).status).toBe(200);
    expect((await fetchFile("bytes=0-1", {}, "empty.bin")).status).toBe(416);
  });
});

describe("fileResponse HEAD", () => {
  it("returns no body stream, so the file is never read", async () => {
    const res = await fileResponse(new Request("http://x/f", { method: "HEAD" }), path.join(dir, "clip.bin"), {
      contentType: "video/mp4",
    });
    expect(res.body).toBeNull();
    expect(res.headers.get("content-length")).toBe(String(BYTES.length));
  });
});
