import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QaGate } from "./qa/gate-profile.js";
import { fakeQa } from "./qa/qa-fakes.test-helpers.js";
import { qaGateWith } from "./render/qa-gate.js";
import { FAKE_HOST, framesOf, pngFrame, sineWav } from "./render/render-fixtures.test-helpers.js";
import { RenderManifestSchema } from "./render/render-manifest.js";
import { defaultRenderDeps, renderVideo, type RenderInput, type RenderResult } from "./render/render-video.js";
import { runRenderCli, type RenderCliDeps } from "./render-cli.js";

const BEAT_IDS = ["beat-01", "beat-02", "beat-03"];
const GATE: QaGate = { sha: "e".repeat(64), gate: ["off-frame"], inspect: {} };

let dir: string;
let png: Buffer;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-render-cli-"));
  pngFrame(path.join(dir, "frame.png"));
  png = readFileSync(path.join(dir, "frame.png"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A synthetic 3 s board of hook beats, the one storyboard kind the composition page draws. */
function writeBoard(): string {
  const beats = BEAT_IDS.map((id, i) => ({ id, type: "hook", duration_s: 1, spoken: `Synthetic line ${i + 1}.`, slots: { line: `Line ${i + 1}` } }));
  const file = path.join(dir, "sample.json");
  writeFileSync(file, JSON.stringify({ video_type: "sample-type", title: "A synthetic board", beats }));
  return file;
}

/** Narration bundle v1 for `ids`: words.json with 1 s beats, and a sine wav per beat that `wavs` names. */
function writeNarration(ids: readonly string[], wavs: readonly string[] = ids): string {
  const audio = path.join(dir, "audio");
  mkdirSync(audio);
  const beats = ids.map((id, i) => ({ id, startS: i, durationS: 1, words: [{ word: `Word${i}.`, start: 0.1, end: 0.4 }] }));
  writeFileSync(path.join(audio, "words.json"), JSON.stringify({ schema: "explainer.words/v1", beats }));
  for (const id of wavs) sineWav(path.join(audio, `${id}.wav`), 0.8);
  return audio;
}

interface Recorded {
  pages: number;
  renders: RenderInput[];
  gates: string[];
  err: string;
}

/** Real renderVideo over a fake browser; the built page is an empty stand-in, since nothing loads it. */
function cliDeps(recorded: Recorded, overrides: Partial<RenderCliDeps> = {}): RenderCliDeps {
  const pageDir = path.join(dir, "page");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(path.join(pageDir, "index.html"), "<!doctype html>");
  const fakeBrowser = { ...defaultRenderDeps, captureFrames: framesOf(png), host: async () => FAKE_HOST, now: () => 0, qaGate: qaGateWith(fakeQa()) };
  return {
    page: async () => {
      recorded.pages++;
      return { dir: pageDir, sha: "a".repeat(64) };
    },
    render: (input) => {
      recorded.renders.push(input);
      return renderVideo(input, fakeBrowser);
    },
    gate: (videoType) => {
      recorded.gates.push(videoType);
      return GATE;
    },
    out: () => undefined,
    err: (text) => void (recorded.err += text),
    ...overrides,
  };
}

const fresh = (): Recorded => ({ pages: 0, renders: [], gates: [], err: "" });
const outDir = () => path.join(dir, "out");
const manifest = () => RenderManifestSchema.parse(JSON.parse(readFileSync(path.join(outDir(), "render-manifest.json"), "utf8")));

describe("explainer render", { timeout: 60_000 }, () => {
  it("a silent render writes the mp4, captions and a draft manifest from a provisional timeline", async () => {
    const recorded = fresh();

    const code = await runRenderCli(["render", writeBoard(), "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(0);
    for (const file of ["sample.mp4", "captions.vtt", "render-manifest.json"]) expect(existsSync(path.join(outDir(), file))).toBe(true);
    expect(manifest()).toMatchObject({ draft: true, durationS: 3, frames: 90 });
    expect(JSON.parse(readFileSync(path.join(outDir(), "timeline.json"), "utf8"))).toMatchObject({ provisional: true, durationS: 3 });
  });

  it("a --no-qa run records qaGate skipped", async () => {
    const recorded = fresh();

    const code = await runRenderCli(["render", writeBoard(), "--no-qa", "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(0);
    expect(recorded.renders[0]?.qa?.mode).toBe("skip");
    expect(manifest().qaGate).toBe("skipped");
  });

  it("without --no-qa the render is gated by the board's video type gate profile", async () => {
    const recorded = fresh();

    const code = await runRenderCli(["render", writeBoard(), "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(0);
    expect(recorded.gates).toEqual(["sample-type"]);
    expect(recorded.renders[0]?.qa).toEqual({ mode: "gate", gate: GATE });
    expect(manifest()).toMatchObject({ qaGate: "passed", qa: { heldErrors: 0, gateProfile: GATE.sha } });
  });

  it("words.json naming a beat the board lacks fails before capture", async () => {
    const recorded = fresh();
    const audio = writeNarration([...BEAT_IDS, "beat-04"]);

    const code = await runRenderCli(["render", writeBoard(), "--audio", audio, "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(1);
    expect(recorded.err).toContain("words.json names beat-04, which the board lacks");
    expect(recorded.pages).toBe(0);
    expect(recorded.renders).toEqual([]);
  });

  it("a narration bundle missing a beat's wav is refused before the page is built", async () => {
    const recorded = fresh();
    const audio = writeNarration(BEAT_IDS, ["beat-01", "beat-03"]);

    const code = await runRenderCli(["render", writeBoard(), "--audio", audio, "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(1);
    expect(recorded.err).toContain("has no wav for beat-02");
    expect(recorded.pages).toBe(0);
  });

  it("a narrated render is not a draft and records the words sha", async () => {
    const recorded = fresh();
    const audio = writeNarration(BEAT_IDS);

    const code = await runRenderCli(["render", writeBoard(), "--audio", audio, "--no-qa", "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(0);
    expect(recorded.renders[0]?.audio?.wavDir).toBe(audio);
    expect(manifest()).toMatchObject({ draft: false, durationS: 3 });
    expect(manifest().shas.words).toMatch(/^[0-9a-f]{64}$/);
  });

  it("workers default to min(16, available parallelism) and --workers overrides them", async () => {
    const recorded = fresh();
    const deps = cliDeps(recorded, { render: async (input) => (recorded.renders.push(input), { data: { frames: 1, durationS: 1, draft: true, qaGate: "skipped" } } as RenderResult) });

    await runRenderCli(["render", writeBoard(), "--no-qa", "--out", outDir()], deps);
    await runRenderCli(["render", writeBoard(), "--no-qa", "--workers", "3", "--out", outDir()], deps);

    expect(recorded.renders.map((input) => input.workers)).toEqual([Math.min(16, availableParallelism()), 3]);
  });

  it("serves the built page and the compiled timeline.json on loopback while rendering", async () => {
    const recorded = fresh();
    const seen: { page?: string; timeline?: unknown } = {};
    const fetchDuringRender: RenderCliDeps["render"] = async (input) => {
      seen.page = await (await fetch(input.pageUrl)).text();
      seen.timeline = await (await fetch(new URL("/timeline.json", input.pageUrl))).json();
      return { data: { frames: 1, durationS: 3, draft: true, qaGate: "skipped" } } as RenderResult;
    };

    const code = await runRenderCli(["render", writeBoard(), "--no-qa", "--out", outDir()], cliDeps(recorded, { render: fetchDuringRender }));

    expect(code).toBe(0);
    expect(seen.page).toBe("<!doctype html>");
    expect(seen.timeline).toMatchObject({ durationS: 3, beats: BEAT_IDS.map((id) => ({ id, kind: "hook" })) });
  });

  it("a worker count that is not a positive integer is a usage error", async () => {
    const recorded = fresh();

    const code = await runRenderCli(["render", writeBoard(), "--workers", "0", "--out", outDir()], cliDeps(recorded));

    expect(code).toBe(2);
    expect(recorded.renders).toEqual([]);
  });
});
