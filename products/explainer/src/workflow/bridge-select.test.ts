import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeFileSchema, readBridgeFile, type BridgeExec } from "./bridge.js";
import { resumeVideo, runVideo } from "./host.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

/** Copies the fixture's data-dir bridge to `<home>/bridges/<name>.json`, with its own workdir and theater. */
function installNamedBridge(fixture: Fixture, name: string): { home: string; workdir: string; theater: string } {
  const home = path.join(fixture.dataDir, "..", "host");
  const workdir = path.join(home, name, "work");
  const theater = path.join(home, name, "theater");
  mkdirSync(path.join(home, "bridges"), { recursive: true });
  const file = BridgeFileSchema.parse(JSON.parse(readFileSync(path.join(fixture.dataDir, "bridge.json"), "utf8")));
  const named = { ...file, workdir, theater: { dir: theater, stem: "daily", files: { mp4: ".mp4" } } };
  writeFileSync(path.join(home, "bridges", `${name}.json`), JSON.stringify(named));
  return { home, workdir, theater };
}

function recordingCwds(exec: BridgeExec, cwds: string[]): BridgeExec {
  return (request) => {
    cwds.push(request.cwd);
    return exec(request);
  };
}

async function tts(fixture: Fixture) {
  const first = await runVideo({ spine: fixture.spine, facts: fixture.facts, to: "tts" }, fakeHost(fixture, fakeScriptModel(), fakeBridge()));
  const outputs = first.report.rows.find((row) => row.stage === "tts")?.outputs ?? {};
  const script = first.report.rows.find((row) => row.stage === "rewrite")?.outputs.script;
  return { words: outputs.words!, audio: outputs.audio!, script: script! };
}

describe("a profile's named bridge", () => {
  it("renders a daily-overview run through the host's bridges/daily.json, not the data dir's bridge.json", async () => {
    fx = fixture();
    const host = installNamedBridge(fx, "daily");
    const pins = await tts(fx);
    const cwds: string[] = [];
    const bridge = fakeBridge();

    const result = await runVideo(
      { from: "render", pins, profile: "daily-overview" },
      fakeHost(fx, fakeScriptModel(), { ...bridge, exec: recordingCwds(bridge.exec, cwds) }, { bridgeHome: host.home }),
    );

    expect(result.status, result.error).toBe("completed");
    expect(cwds.length).toBeGreaterThan(0);
    expect(cwds.every((cwd) => cwd === host.workdir)).toBe(true);
    expect(existsSync(path.join(host.theater, "daily.mp4"))).toBe(true);
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(false);
  });

  it("keeps the data dir's bridge.json for a profile that names no bridge", async () => {
    fx = fixture();
    installNamedBridge(fx, "daily");
    const pins = await tts(fx);
    const cwds: string[] = [];
    const bridge = fakeBridge();

    const result = await runVideo({ from: "render", pins, profile: "repo-tour" }, fakeHost(fx, fakeScriptModel(), { ...bridge, exec: recordingCwds(bridge.exec, cwds) }));

    expect(result.status, result.error).toBe("completed");
    expect(cwds.every((cwd) => cwd === fx!.workdir)).toBe(true);
  });

  it("fails naming the missing file when the profile's bridge is not installed", async () => {
    fx = fixture();
    const pins = await tts(fx);

    const result = await runVideo({ from: "render", pins, profile: "daily-overview" }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status).toBe("failed");
    expect(result.error).toContain(path.join("bridges", "daily.json"));
  });
});

describe("--theater", () => {
  it("links the export into the given folder in place of the bridge's theater.dir", async () => {
    fx = fixture();
    const pins = await tts(fx);
    const scratch = path.join(fx.dataDir, "..", "scratch-theater");

    const result = await runVideo({ from: "render", pins, theater: scratch }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(existsSync(path.join(scratch, "demo.mp4"))).toBe(true);
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(false);
  });

  it("keeps the given folder when a run that failed before export is resumed", async () => {
    fx = fixture();
    const scratch = path.join(fx.dataDir, "..", "scratch-theater");
    const failed = await runVideo({ spine: fx.spine, facts: fx.facts, theater: scratch }, fakeHost(fx, fakeScriptModel(), fakeBridge({ qaFails: true })));

    const resumed = await resumeVideo(failed.runId, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    expect(failed.status).toBe("failed");
    expect(resumed.status, resumed.error).toBe("completed");
    expect(existsSync(path.join(scratch, "demo.mp4"))).toBe(true);
    expect(existsSync(path.join(fx.theater, "demo.mp4"))).toBe(false);
  });
});

describe("a host bridge after the sheets port", () => {
  it("refuses a host file that still bridges sheets, naming the block to delete", () => {
    fx = fixture();
    const file = path.join(fx.dataDir, "bridge.json");
    const bridge = JSON.parse(readFileSync(file, "utf8")) as { stages: Record<string, unknown> };
    const stale = { ...bridge, stages: { ...bridge.stages, sheets: { inputs: { mp4: "out/demo.mp4" }, outputs: {}, commands: [{ argv: ["bash", "sheets.sh"] }] } } };
    writeFileSync(file, JSON.stringify(stale));

    const read = () => readBridgeFile(fx!.dataDir);

    expect(read).toThrow(/still has a "sheets" block, but sheets runs in TypeScript now.*delete it/);
  });
});
