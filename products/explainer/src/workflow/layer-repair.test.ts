import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentChatRepairer } from "../build/agent-chat-repairer.js";
import type { BeatWorker } from "../build/beat-worker.js";
import { FAKE_SESSION_ID } from "../build/fake-agent-chat.test-helpers.js";
import { runOneStage } from "./host.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { BROKEN, brokenWorker, customBeatInputs, fakeAgentChatBeside, REPAIRED } from "./layer-repair.test-helpers.js";
import { StageRecordSchema } from "./records.js";
import { readJson, runPaths } from "./run-dir.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, a fake agent-chat and a one-request transcript; no real script, roster or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

function hostWith(worker: BeatWorker, repaired?: string) {
  const fake = fakeAgentChatBeside(fx.dataDir, repaired);
  const layerRepairer = agentChatRepairer({ agentChatBin: fake.bin, profilesDir: fake.profilesDir, claudeConfigDir: fake.configDir, pollMs: 1 });
  return { fake, host: fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: worker, layerRepairer }) };
}

const failedRecords = () => readdirSync(path.join(fx.dataDir, "runs"))
  .map((runId) => readJson(runPaths(fx.dataDir, runId).failed("resolve"), StageRecordSchema))
  .filter((record) => record !== undefined);

describe("the repair round on a custom layer that fails the compile gate", () => {
  it("spawns one repair agent, stores the module it wrote, and counts its transcript-priced spend with its session id", async () => {
    fx = fixture();
    const { host, fake } = hostWith(brokenWorker().worker, REPAIRED);

    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, host);

    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(fake.spawn()?.argv).toContain("--brief-stdin");
    expect(record.outputs[CUSTOM_LAYERS]).toBeDefined();
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(REPAIRED);
    expect(record.usage.usd).toBeCloseTo(0.05, 10);
    expect(record.usage).toMatchObject({ calls: 2 });
    expect(record.usage.costUnknown).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(tree, "layers.json"), "utf8"))).toMatchObject({ layers: [{ beat: "b1", repairSessionId: FAKE_SESSION_ID }] });
  });

  it("keeps a repair that still fails marked for repair, with its spend and session, and never caches it", async () => {
    fx = fixture();
    const pins = customBeatInputs(fx.dataDir);
    const { host } = hostWith(brokenWorker().worker, BROKEN);

    const run = runOneStage({ stage: "resolve", inputs: pins }, host);

    await expect(run).rejects.toThrow(new RegExp(`b1 \\(needs repair: still fails after repair \\(repair session ${FAKE_SESSION_ID}\\): layer\\.tsx:\\d+:\\d+: `));
    const [failed] = failedRecords();
    expect(failed?.usage.usd).toBeCloseTo(0.05, 10);
    expect(failed?.usage.costUnknown).toBeUndefined();
    const retry = brokenWorker();
    await expect(runOneStage({ stage: "resolve", inputs: pins }, hostWith(retry.worker, BROKEN).host)).rejects.toThrow(/still fails after repair/);
    expect(retry.calls).toEqual(["b1"]);
  });

  it("keeps the build marked for repair, with the repair's spend, when the agent wrote no module", async () => {
    fx = fixture();
    const { host } = hostWith(brokenWorker().worker);

    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, host);

    await expect(run).rejects.toThrow(/b1 \(needs repair: layer\.tsx:.*; the repair wrote no module \(repair session /);
    expect(failedRecords()[0]?.usage.usd).toBeCloseTo(0.05, 10);
    expect(existsSync(path.join(fx.dataDir, "layer-builds"))).toBe(false);
  });
});
