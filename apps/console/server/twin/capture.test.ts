import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embedSnapshot } from "@titan-design/react-app";
import { PAGE_FILE } from "../paths.js";
import { captureTwin, NondeterministicCaptureError, type TwinManifest } from "./capture.js";
import { TWIN_VIEWPORTS } from "./routes.js";
import { twinSnapshot } from "./snapshot.js";

const BROWSER_TIMEOUT_MS = 120_000;
const SMALL = { small: { width: 240, height: 120 } };

/** A page that writes the clock into itself: the leak a twin capture must refuse. */
const CLOCK_SCRIPT = `<script>addEventListener("load", () => {
  const stamp = document.createElement("div");
  stamp.style.cssText = "position:fixed;top:0;left:0;z-index:9999;color:#fff";
  stamp.textContent = String(Date.now());
  document.body.append(stamp);
})</script>`;

const page = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#222;color:#eee">${body}</body></html>`;

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "twin-capture-test-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const sha = async (file: string): Promise<string> => createHash("sha256").update(await readFile(file)).digest("hex");

describe("a twin capture", { timeout: BROWSER_TIMEOUT_MS }, () => {
  it("writes one frame per route and viewport, with its hash in the manifest", async () => {
    const manifest = await captureTwin({ html: page("<p>steady</p>"), routes: [{ name: "steady", hash: "#/steady" }], viewports: SMALL, outDir });

    const written = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8")) as TwinManifest;
    expect(written).toEqual(manifest);
    expect(manifest.frames).toEqual([expect.objectContaining({ route: "steady", viewport: "small", file: path.join("small", "steady.png") })]);
    expect(await sha(path.join(outDir, "small", "steady.png"))).toBe(manifest.frames[0]!.sha256);
  });

  it("fails when a page prints the clock, and keeps both shots", async () => {
    const capture = captureTwin({ html: page(CLOCK_SCRIPT), routes: [{ name: "clock", hash: "#/" }], viewports: SMALL, outDir });

    await expect(capture).rejects.toThrow(new NondeterministicCaptureError(["clock@small"]));
    expect(await sha(path.join(outDir, "small", "clock.png"))).not.toBe(await sha(path.join(outDir, "small", "clock.second.png")));
  });

  it("fails when a page reaches for the network", async () => {
    const capture = captureTwin({ html: page('<img src="http://127.0.0.1:9/frame.png">'), routes: [{ name: "net", hash: "#/" }], viewports: SMALL, outDir });

    await expect(capture).rejects.toThrow("asked the network for http://127.0.0.1:9/frame.png");
  });
});

describe("the console's twin", { timeout: BROWSER_TIMEOUT_MS }, () => {
  const routes = [
    { name: "home", hash: "#/" },
    { name: "inbox", hash: "#/inbox" },
  ];

  /** The built page `pnpm build` leaves, which the test suite runs after. */
  async function consolePage(): Promise<string> {
    return embedSnapshot(await readFile(PAGE_FILE, "utf8"), await twinSnapshot());
  }

  it("renders the same bytes twice at both widths", async () => {
    const manifest = await captureTwin({ html: await consolePage(), routes, viewports: TWIN_VIEWPORTS, outDir });

    expect(manifest.frames.map((frame) => `${frame.route}@${frame.viewport}`)).toEqual(["home@phone", "home@desktop", "inbox@phone", "inbox@desktop"]);
  });

  it("fails once Date.now reaches the page", async () => {
    const html = (await consolePage()).replace("</body>", `${CLOCK_SCRIPT}</body>`);

    await expect(captureTwin({ html, routes: routes.slice(1), viewports: TWIN_VIEWPORTS, outDir })).rejects.toThrow(new NondeterministicCaptureError(["inbox@phone", "inbox@desktop"]));
  });
});
