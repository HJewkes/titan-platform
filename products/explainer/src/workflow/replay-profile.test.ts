import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVideo, type RunOutcome } from "./host.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";
import { DEFAULT_VOICE } from "./stage-spec.js";

// Synthetic: the fixture's invented script, voiced on fakes; no real run or script.
let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

function voiceOf(result: RunOutcome): { id: string; rate: number; source: string } {
  const sha = result.report.rows.find((row) => row.stage === "tts")!.outputs.voice!;
  return JSON.parse(readFileSync(path.join(fx!.dataDir, "artifacts", sha), "utf8"));
}

async function profiledBase(profile: string): Promise<{ first: RunOutcome; host: () => ReturnType<typeof fakeHost> }> {
  fx = fixture();
  const host = () => fakeHost(fx!, fakeScriptModel(), fakeRender());
  return { first: await runVideo({ spine: fx.spine, facts: fx.facts, profile, to: "tts" }, host()), host };
}

describe("a later run on a base run", () => {
  it("speaks in the base run's profile voice when it names no profile of its own", async () => {
    // Arrange
    const { first, host } = await profiledBase("repo-argument");

    // Act
    const replay = await runVideo({ from: "resolve", to: "tts", base: first.runId }, host());

    // Assert
    expect([first.status, replay.status], replay.error).toEqual(["completed", "completed"]);
    expect(voiceOf(first).id).not.toBe(DEFAULT_VOICE.id);
    expect(voiceOf(replay)).toMatchObject({ id: voiceOf(first).id, rate: voiceOf(first).rate, source: "profile repo-argument" });
  });

  it("speaks in the profile it names over the base run's", async () => {
    // Arrange
    const { first, host } = await profiledBase("repo-argument");

    // Act
    const replay = await runVideo({ from: "resolve", to: "tts", base: first.runId, profile: "repo-tour" }, host());

    // Assert
    expect(replay.status, replay.error).toBe("completed");
    expect(voiceOf(replay).source).toBe("profile repo-tour");
  });
});
