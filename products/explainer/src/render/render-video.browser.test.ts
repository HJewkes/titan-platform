import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeStreams, timelineOf } from "./render-fixtures.test-helpers.js";
import { defaultRenderDeps, renderVideo } from "./render-video.js";

/** A synthetic two-beat page that speaks `__titanMotion` by hand: the beat id and t, on a colour per beat. */
const PAGE = `<!doctype html><html><body style="margin:0"><div id="stage" style="position:absolute;inset:0;font:96px sans-serif"></div>
<script>
const stage = document.getElementById("stage");
window.__titanMotion = {
  duration: 2,
  seek(t) { stage.textContent = (t < 1 ? "beat-1 " : "beat-2 ") + t.toFixed(3); stage.style.background = t < 1 ? "#cde" : "#edc"; },
  ready() { return Promise.resolve(); },
};
window.__titanMotion.seek(0);
</script></body></html>`;

let server: Server;
let url: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-render-browser-"));
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("renderVideo in a real browser", { timeout: 180_000 }, () => {
  it("renders a 2 s page to 60 frames of 1920x1080 H.264 with an AAC track", async () => {
    const timeline = timelineOf([1, 1]);

    const result = await renderVideo({ timeline, pageUrl: url, pageSha: "c".repeat(64), workers: 2, outDir: dir, stem: "browser" }, defaultRenderDeps);

    const [video, audio] = probeStreams(result.mp4);
    expect(video).toMatchObject({ codec_name: "h264", width: 1920, height: 1080, nb_read_frames: "60" });
    expect(audio?.codec_name).toBe("aac");
    expect(result.data).toMatchObject({ frames: 60, pageDurationS: 2, durationS: 2, draft: true });
  });
});
