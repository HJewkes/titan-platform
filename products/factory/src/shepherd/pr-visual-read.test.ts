import zlib from "node:zlib";
import type { MergeFacts } from "@titan-design/authority";
import type { GitHubPort } from "@titan-design/github";
import { encodePng } from "@titan-design/png-delta";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { ghPrVisual, type PrVisualGh } from "./pr-visual-read.js";
import { readVisualTier } from "./visual-tier-guard.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);
const REPO = "octo/design";
const WORKFLOW = ".github/workflows/pr-visual.yml";
const RENDERED = "src/button/button.tsx";

const config = {
  mode: "on",
  storyPaths: ["src/**/*.stories.tsx"],
  logicPaths: ["src/**"],
  testArtifactPaths: ["src/contrast-baseline.json"],
  renderingPaths: ["src/tokens/**"],
  harnessPaths: ["scripts/capture/**"],
  storyDiff: { check: "visual", paths: ["**/__snapshots__/**"], allowedApps: [15368] },
  prVisual: { workflow: WORKFLOW, pixelTolerance: 0.1 },
};

/** A synthetic 2x2 image: grey, with one pixel's red channel nudged by `nudge`. */
function png(nudge = 0): Buffer {
  const rgba = new Uint8Array(16).fill(128);
  for (let alpha = 3; alpha < 16; alpha += 4) rgba[alpha] = 255;
  rgba[0] = 128 + nudge;
  return encodePng({ width: 2, height: 2, rgba });
}

function zipOf(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = zlib.deflateRawSync(data);
    const fields = Buffer.alloc(16);
    fields.writeUInt32LE(zlib.crc32(data), 0);
    fields.writeUInt32LE(packed.length, 4);
    fields.writeUInt32LE(data.length, 8);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    fields.copy(local, 14, 0, 12);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    fields.copy(central, 16, 0, 12);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, Buffer.from(name), packed);
    centrals.push(central, Buffer.from(name));
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const shot = (story: string, width: string) => ({ story, width, before: `before/${story}@${width}.png`, after: `after/${story}@${width}.png` });

interface Artifact {
  /** One `[before, after]` pair per shot, in manifest order. */
  pairs: [Buffer, Buffer][];
  manifest?: Record<string, unknown>;
  runHead?: string;
  size?: number;
}

function artifactZip({ pairs, manifest }: Artifact): Buffer {
  const shots = pairs.map((_, index) => shot(`button--s${index}`, "1280"));
  const files: Record<string, Buffer> = {};
  pairs.forEach(([before, after], index) => Object.assign(files, { [shots[index].before]: before, [shots[index].after]: after }));
  const body = { v: 1, repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD, rendered: true, shots, ...manifest };
  return zipOf({ "manifest.json": Buffer.from(JSON.stringify(body)), ...files });
}

function fakeGh(artifact: Artifact): PrVisualGh {
  const zip = artifactZip(artifact);
  const listed = { id: 41, expired: false, size_in_bytes: artifact.size ?? zip.length, workflow_run: { id: 9, head_sha: artifact.runHead ?? HEAD } };
  return {
    text: async (args) => (args.includes("--paginate") ? `${JSON.stringify(listed)}\n` : JSON.stringify({ path: WORKFLOW })),
    bytes: async () => zip,
  };
}

async function tierOf(artifact: Artifact, limits: { zipBytes?: number } = {}) {
  const port = partialFake<Pick<GitHubPort, "compareFiles">>({ compareFiles: async () => partialFake({ mergeBaseSha: BASE }) });
  const merge = partialFake<MergeFacts>({ head: HEAD, changedPaths: [RENDERED], checkRuns: [] });
  const target = { repo: REPO, baseRef: "main", visualPaths: ["src/**"], config, readPixel: ghPrVisual(fakeGh(artifact), limits) };
  return (await readVisualTier(port, merge, target))?.visualTier.verdict;
}

describe("the pr-visual pixel path (TP-4761 S4)", () => {
  it("artifact with zero changed pixels on every shot is tier 1 no-diff", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()], [png(), png(1)]] });

    expect(verdict).toEqual({ tier: 1, basis: "no-pixel-diff" });
  });

  it("one shot with changed pixels is tier 2", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()], [png(), png(120)]] });

    expect(verdict).toMatchObject({ tier: 2, reason: expect.stringMatching(/^no pixel proof: shots\.1\.changedPixels/) });
  });

  it("artifact at another head is tier 2", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()]], runHead: OTHER });

    expect(verdict).toEqual({ tier: 2, reason: "no pixel proof: no pr-visual artifact from the configured workflow at the head" });
  });

  it("rendered false while Shepherd sees a rendered path is tier 2", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()]], manifest: { rendered: false } });

    expect(verdict).toMatchObject({ tier: 2, reason: expect.stringContaining("rendered nothing") });
  });

  it("artifact over the byte cap is tier 2 unmeasured", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()]] }, { zipBytes: 64 });

    expect(verdict).toEqual({ tier: 2, reason: "no pixel proof: artifact over the 64-byte cap" });
  });
});
