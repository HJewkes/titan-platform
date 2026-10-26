import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOneStage } from "./host.js";
import { brokenWorker, customBeatInputs, fakeAgentChatBeside, REPAIRED } from "./layer-repair.test-helpers.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk and a fake agent-chat; no real roster, profile or session.
let fx: Fixture;
afterEach(() => {
  vi.unstubAllEnvs();
  fx.cleanup();
});

describe("the host's repairer until TP-2608's profile lands", () => {
  it("makes no repair spawn when the host passes no repairer, even with agent-chat on PATH and AGENT_CHAT_BIN set", async () => {
    fx = fixture();
    const fake = fakeAgentChatBeside(fx.dataDir, REPAIRED);
    const root = path.dirname(fake.bin);
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("AGENT_CHAT_BIN", fake.bin);
    vi.stubEnv("AGENT_CHAT_HOME", root);
    vi.stubEnv("CLAUDE_CONFIG_DIR", fake.configDir);
    const host = fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: brokenWorker().worker });

    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, host);

    await expect(run).rejects.toThrow(/b1 \(needs repair: layer\.tsx:(?:(?!repair).)*\)$/);
    expect(fake.spawn()).toBeUndefined();
  });
});
