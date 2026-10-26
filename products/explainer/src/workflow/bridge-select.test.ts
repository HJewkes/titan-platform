import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeFileSchema, readBridgeFile } from "./bridge.js";
import { resumeVideo, runVideo } from "./host.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";
import { fakeQa, heldOverlap } from "../qa/qa-fakes.test-helpers.js";

let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

/** Copies the fixture's data-dir bridge to `<home>/bridges/<name>.json`, with its own theater. */
function installNamedBridge(fixture: Fixture, name: string): { home: string; theater: string } {
  const home = path.join(fixture.dataDir, "..", "host");
  const theater = path.join(home, name, "theater");
  mkdirSync(path.join(home, "bridges"), { recursive: true });
  const file = BridgeFileSchema.parse(JSON.parse(readFileSync(path.join(fixture.dataDir, "bridge.json"), "utf8")));
  const named = { ...file, theater: { dir: theater, stem: "daily", files: { mp4: ".mp4" } } };
  writeFileSync(path.join(home, "bridges", `${name}.json`), JSON.stringify(named));
  return { home, theater };
}

/** The fixture's bridge.json carrying `stages`, as a host file written before those stages were ported. */
function withStages(fixture: Fixture, stages: Record<string, unknown>): void {
  const file = path.join(fixture.dataDir, "bridge.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), stages }));
}

async function tts(fixture: Fixture) {
  const first = await runVideo({ spine: fixture.spine, facts: fixture.facts, to: "tts" }, fakeHost(fixture, fakeScriptModel(), fakeRender()));
  const outputs = first.report.rows.find((row) => row.stage === "tts")?.outputs ?? {};
  const script = first.report.rows.find((row) => row.stage === "rewrite")?.outputs.script;
  const resolved = first.report.rows.find((row) => row.stage === "resolve")?.outputs.resolved;
  return { words: outputs.words!, audio: outputs.audio!, script: script!, resolved: resolved! };
}

describe("a profile's named bridge", () => {
  it("links a daily-overview run through the host's bridges/daily.json, not the data dir's bridge.json", async () => {
    fx = fixture();
    const host = installNamedBridge(fx, "daily");
    const pins = await tts(fx);

    const result = await runVideo({ from: "render", pins, profile: "daily-overview" }, fakeHost(fx, fakeScriptModel(), fakeRender(), { bridgeHome: host.home }));

    expect(result.status, result.error).toBe("completed");
    expect(existsSync(path.join(host.theater, "daily.mp4"))).toBe(true);
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(false);
  });

  it("keeps the data dir's bridge.json for a profile that names no bridge", async () => {
    fx = fixture();
    installNamedBridge(fx, "daily");
    const pins = await tts(fx);

    const result = await runVideo({ from: "render", pins, profile: "repo-tour" }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(result.status, result.error).toBe("completed");
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(true);
  });

  it("fails naming the missing file when the profile's bridge is not installed", async () => {
    fx = fixture();
    const pins = await tts(fx);

    const result = await runVideo({ from: "render", pins, profile: "daily-overview" }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(result.status).toBe("failed");
    expect(result.error).toContain(path.join("bridges", "daily.json"));
  });
});

describe("--theater", () => {
  it("links the export into the given folder in place of the bridge's theater.dir", async () => {
    fx = fixture();
    const pins = await tts(fx);
    const scratch = path.join(fx.dataDir, "..", "scratch-theater");

    const result = await runVideo({ from: "render", pins, theater: scratch }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(result.status, result.error).toBe("completed");
    expect(existsSync(path.join(scratch, "demo.mp4"))).toBe(true);
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(false);
  });

  it("keeps the given folder when a run that failed before export is resumed", async () => {
    fx = fixture();
    const scratch = path.join(fx.dataDir, "..", "scratch-theater");
    const failed = await runVideo({ spine: fx.spine, facts: fx.facts, theater: scratch }, fakeHost(fx, fakeScriptModel(), fakeRender(), { qaEngine: fakeQa(heldOverlap()) }));

    const resumed = await resumeVideo(failed.runId, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(failed.status).toBe("failed");
    expect(resumed.status, resumed.error).toBe("completed");
    expect(existsSync(path.join(scratch, "demo.mp4"))).toBe(true);
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(false);
  });
});

describe("a host bridge after the sheets port", () => {
  it("refuses a host file that still bridges sheets, naming the block to delete", () => {
    fx = fixture();
    withStages(fx, { sheets: { inputs: { mp4: "out/demo.mp4" }, outputs: {}, commands: [{ argv: ["bash", "sheets.sh"] }] } });

    const read = () => readBridgeFile(fx!.dataDir);

    expect(read).toThrow(/still has a "sheets" block, but sheets runs in TypeScript now.*delete it/);
  });
});

describe("a host bridge after the qa port", () => {
  it("refuses a host file that still bridges qa, naming the block to delete", () => {
    fx = fixture();
    withStages(fx, { qa: { inputs: { page: "out/page" }, outputs: {}, commands: [{ argv: ["node", "examples/qa.ts", "demo"] }] } });

    const read = () => readBridgeFile(fx!.dataDir);

    expect(read).toThrow(/still has a "qa" block, but qa runs in TypeScript now \(render-qa\); delete it, and drop examples\/qa.ts/);
  });
});

describe("a host bridge after the render port", () => {
  const RENDER_BLOCK = {
    inputs: { script: "in/script.json" }, outputs: { mp4: { path: "out/demo.mp4" } },
    commands: [{ argv: ["python3", "-I", "tools/build_sample.py"] }, { argv: ["vite", "build"] }, { argv: ["node", "examples/render.ts", "demo"] }],
  };

  it("refuses a host file that still bridges render, naming each retired command and where it went", () => {
    fx = fixture();
    withStages(fx, { render: RENDER_BLOCK });

    const read = () => readBridgeFile(fx!.dataDir);

    expect(read).toThrow(/still has a "render" block, but render runs in TypeScript now; delete it/);
    expect(read).toThrow(/build_sample\.py \(the template fill draws the storyboard from script and resolved\)/);
    expect(read).toThrow(/vite build \(the composition page, built once per source sha in the explainer cache\)/);
    expect(read).toThrow(/render\.ts \(renderVideo: capture, mix, captions\.vtt, render-manifest\.json, its QA gate\)/);
  });

  it("renders a run whose host file has no render block", async () => {
    fx = fixture();
    const pins = await tts(fx);
    withStages(fx, {});

    const result = await runVideo({ from: "render", pins }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    expect(result.status, result.error).toBe("completed");
  });
});
