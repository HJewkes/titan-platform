import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { RenderManifestSchema, collectRenderHost, renderManifestJson, type RenderManifest } from "./render-manifest.js";

const SHA = "b".repeat(64);
const MANIFEST: RenderManifest = {
  schema: "explainer.render-manifest/v1", workers: 2, fps: 30, frames: 60, durationS: 2, pageDurationS: 2, renderWallS: 1.5,
  draft: true, qaGate: "absent",
  host: { platform: "linux", arch: "x64", cpuModel: "Synthetic CPU", cpus: 4, node: "v0.0.0", ffmpeg: "ffmpeg version 0", chromium: "0.0.0.0" },
  shas: { timeline: SHA, page: SHA, mix: SHA, mp4: SHA, vtt: SHA },
};

describe("render manifest", () => {
  it("refuses a hostname added to the host block", () => {
    const withHostname = { ...MANIFEST, host: { ...MANIFEST.host, hostname: "build-box" } };

    const parse = () => RenderManifestSchema.parse(withHostname);

    expect(parse).toThrow();
  });

  it("refuses an output path added at the top level", () => {
    const withPath = { ...MANIFEST, outDir: "/tmp/out" };

    const write = () => renderManifestJson(withPath);

    expect(write).toThrow();
  });

  it("refuses a manifest that claims a QA gate passed with no qa record", () => {
    const passed = { ...MANIFEST, qaGate: "passed" };

    const parse = () => RenderManifestSchema.parse(passed);

    expect(parse).toThrow("qa is recorded exactly when qaGate is passed");
  });

  it("refuses a qa record on a render whose gate was skipped", () => {
    const skipped = { ...MANIFEST, qaGate: "skipped", qa: { heldErrors: 0, gateProfile: SHA } };

    const parse = () => RenderManifestSchema.parse(skipped);

    expect(parse).toThrow("qa is recorded exactly when qaGate is passed");
  });

  it("collects this machine's host without its hostname, user or home directory", { timeout: 60_000 }, async () => {
    const host = await collectRenderHost();

    const text = renderManifestJson({ ...MANIFEST, host });
    expect(Object.keys(host).sort()).toEqual(["arch", "chromium", "cpuModel", "cpus", "ffmpeg", "node", "platform"]);
    expect(host.ffmpeg).toMatch(/^ffmpeg version \S+/);
    expect(host.chromium).toMatch(/^\d+\.\d+/);
    for (const secret of [hostname(), userInfo().username, homedir(), tmpdir()]) expect(text).not.toContain(secret);
  });
});
