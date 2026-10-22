import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./artifacts.js";
import { resumeVideo, runVideo } from "./host.js";
import { STAGES } from "./records.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

const row = (outcome: Awaited<ReturnType<typeof runVideo>>, stage: string) => outcome.report.rows.find((r) => r.stage === stage)!;

describe("explainer run", () => {
  it("runs every stage in order and ends with the MP4 linked into the theater", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(result.status, result.error).toBe("completed");
    expect(result.report.rows.map((r) => [r.stage, r.status])).toEqual(STAGES.map((stage) => [stage, "ran"]));
    expect(bridge.calls).toEqual(["tts.mjs", "render.ts", "qa.ts", "sheets.sh"]);
    const theaterMp4 = path.join(fx.theater, "demo.mp4");
    expect(sha256(readFileSync(theaterMp4))).toBe(row(result, "render").outputs.mp4);
    expect(row(result, "export").outputs.mp4).toBe(row(result, "render").outputs.mp4);
  });

  it("hands the tts command the rewritten script, not the draft", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(bridge.ttsInputs).toEqual([row(result, "rewrite").outputs.script]);
    expect(row(result, "rewrite").outputs.script).not.toBe(row(result, "script").outputs.draft);
  });
});
