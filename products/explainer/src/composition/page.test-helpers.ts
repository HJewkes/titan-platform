import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFrames, startEncoder } from "@titan-design/frame-capture";
import { build } from "vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export const STAGE = { width: 1920, height: 1080 };
const FPS = 10;

/** One production build of the page into a fresh temp dir. */
export async function buildPage(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "explainer-composition-"));
  await build({ configFile: join(HERE, "vite.config.ts"), logLevel: "silent", build: { outDir } });
  return outDir;
}

export interface PageServer {
  url(page: "index.html" | "baked.html", timeline?: string): string;
  close(): Promise<void>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Loopback HTTP over the built page, with the fixture timelines at /timelines/ and, held back by `slowMs`, at /slow/. */
export async function servePage(pageDir: string, slowMs: number): Promise<PageServer> {
  const server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://page").pathname);
    const [, prefix = "", ...rest] = path.split("/");
    const file = prefix === "timelines" || prefix === "slow" ? join(FIXTURES, ...rest) : join(pageDir, path);
    const held = prefix === "slow" ? delay(slowMs) : Promise.resolve();
    held
      .then(() => readFile(file))
      .then(
        (body) => res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body),
        () => res.writeHead(404).end(),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (page, timeline) => `http://127.0.0.1:${port}/${page}${timeline ? `?timeline=${timeline}` : ""}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function silentWav(dir: string, durationS: number): string {
  const wav = join(dir, "silence.wav");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(durationS), wav]);
  return wav;
}

export interface Render {
  mp4: Buffer;
  frames: Buffer[];
  pageDurationS: number;
}

/** Captures the page at FPS on one worker and encodes it over silence, as the render command will. */
export async function renderMp4(url: string): Promise<Render> {
  const dir = mkdtempSync(join(tmpdir(), "explainer-render-"));
  const frames: Buffer[] = [];
  const result = await captureFrames({ url, fps: FPS, ...STAGE, workers: 1 }, async (i, png) => {
    frames[i] = png;
  });
  const encoder = startEncoder(join(dir, "out.mp4"), FPS, silentWav(dir, result.pageDurationS));
  for (const png of frames) await encoder.write(png);
  await encoder.finish();
  return { mp4: readFileSync(join(dir, "out.mp4")), frames, pageDurationS: result.pageDurationS };
}

export function fixtureDurationS(name: string): number {
  return (JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as { durationS: number }).durationS;
}
