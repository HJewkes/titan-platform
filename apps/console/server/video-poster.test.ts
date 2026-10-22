import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticMp4 } from "./test-support.js";
import { VIDEO_META_SCHEMA } from "./video-meta.js";
import { scanVideos, servePoster, videoCatalog } from "./videos.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "console-poster-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "console-poster-out-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function put(relative: string, body: string | Buffer): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

const sidecar = (fields: object) => JSON.stringify({ schema: VIDEO_META_SCHEMA, ...fields });

async function getPoster(): Promise<Response> {
  const catalog = videoCatalog({ roots: [root] });
  const [video] = (await scanVideos([root])).videos;
  return servePoster(new Request(`http://console.test/media/videos/${video!.id}/poster`), catalog, video!.id);
}

async function body(response: Response): Promise<string> {
  return response.text();
}

describe("GET /media/videos/:id/poster", () => {
  beforeEach(async () => {
    await put("orbit/cut.mp4", syntheticMp4());
  });

  it("serves the sidecar's poster ahead of the stem-poster files", async () => {
    await put("orbit/cut.video.json", sidecar({ poster: "chosen.png" }));
    await put("orbit/chosen.png", "chosen");
    await put("orbit/cut-poster.jpg", "jpg");

    const response = await getPoster();

    expect([response.status, response.headers.get("content-type"), await body(response)]).toEqual([200, "image/png", "chosen"]);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("prefers the stem jpg over the stem png when no sidecar names one", async () => {
    await put("orbit/cut-poster.jpg", "jpg");
    await put("orbit/cut-poster.png", "png");

    const response = await getPoster();

    expect([response.status, response.headers.get("content-type"), await body(response)]).toEqual([200, "image/jpeg", "jpg"]);
  });

  it("falls back to the stem png, then to 404", async () => {
    await put("orbit/cut-poster.png", "png");
    expect((await getPoster()).status).toBe(200);
    await rm(path.join(root, "orbit", "cut-poster.png"));
    expect((await getPoster()).status).toBe(404);
  });

  it("falls through a sidecar poster that does not exist", async () => {
    await put("orbit/cut.video.json", sidecar({ poster: "missing.jpg" }));
    await put("orbit/cut-poster.png", "png");

    expect(await body(await getPoster())).toBe("png");
  });

  it("never serves a contact sheet, even when the sidecar names one", async () => {
    await put("orbit/cut.video.json", sidecar({ poster: "cut-contact-sheet.jpg" }));
    await put("orbit/cut-contact-sheet.jpg", "sheet");
    await put("orbit/cut-contact.png", "sheet");

    expect((await getPoster()).status).toBe(404);
  });

  it("refuses a sidecar poster that names a path outside the video's folder", async () => {
    await writeFile(path.join(outside, "secret.png"), "secret");
    await put("orbit/cut.video.json", sidecar({ poster: `../../${path.basename(outside)}/secret.png` }));

    expect((await getPoster()).status).toBe(404);
  });

  it("refuses a poster that is a symlink out of the root", async () => {
    await writeFile(path.join(outside, "secret.jpg"), "secret");
    await symlink(path.join(outside, "secret.jpg"), path.join(root, "orbit", "cut-poster.jpg"));

    expect((await getPoster()).status).toBe(404);
  });

  it("refuses a poster that is a symlink to a file inside the root", async () => {
    await put("orbit/real.jpg", "real");
    await symlink(path.join(root, "orbit", "real.jpg"), path.join(root, "orbit", "cut-poster.jpg"));

    expect((await getPoster()).status).toBe(404);
  });
});
