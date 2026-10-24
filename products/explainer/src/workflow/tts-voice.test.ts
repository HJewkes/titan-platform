import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { BridgeFileSchema, readBridgeFile } from "./bridge.js";
import { DEFAULT_VOICE, stageSpec, type RunSettings, type Variant } from "./stage-spec.js";

const SETTINGS: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 1 };
const BRIDGE = () => BridgeFileSchema.parse({ schema: "explainer-bridge/v1", workdir: "/work", theater: { dir: "/theater", stem: "demo", files: {} }, stages: {} });

function ttsSpec(profile?: string, params?: Variant["params"]) {
  const variant = params ? { sha: "b".repeat(64), value: { schema: "explainer.variant/v1" as const, stage: "tts" as const, name: "v", params } } : undefined;
  const settings = profile ? { ...SETTINGS, profile } : SETTINGS;
  return stageSpec({ stage: "tts", artifacts: { script: "a".repeat(64), resolved: "d".repeat(64), spine: "c".repeat(64) }, settings, sample: 0, remainingUsd: 1, bridge: BRIDGE, ...(variant ? { variant } : {}) });
}

describe("tts stage spec", () => {
  it("reads the script and its resolved beat types, and speaks in the run profile's voice band", () => {
    const spec = ttsSpec("repo-argument");

    expect(spec.inputs).toEqual({ script: "a".repeat(64), resolved: "d".repeat(64) });
    expect(spec.config.voice).toEqual({ id: "am_michael", rate: 1, source: "profile repo-argument" });
  });

  it("keys on each speech band's words a minute from doctrine (C5: story 195, concept 175, code 160, takeaways 180)", () => {
    expect(ttsSpec().config.rates).toEqual({ story: 195, concept: 175, code: 160, takeaways: 180, held: 175 });
  });

  it("lays a tts variant's voice and rate over the profile's, and keys on them", () => {
    const spec = ttsSpec("repo-argument", { rate: 1.2 });

    expect(spec.config.voice).toEqual({ id: "am_michael", rate: 1.2, source: "variant" });
    expect(spec.key).not.toBe(ttsSpec("repo-argument").key);
  });

  it("falls back to the default voice when the run names no profile", () => {
    expect(ttsSpec().config.voice).toEqual({ ...DEFAULT_VOICE, source: "default" });
  });

  it("refuses a tts variant param other than voice and rate", () => {
    expect(() => ttsSpec(undefined, { workers: 4 })).toThrow(/workers/);
  });
});

describe("bridge host file after the tts port", () => {
  it("refuses a host file that still bridges tts, saying what to move", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "explainer-bridge-"));
    const stale = { schema: "explainer-bridge/v1", workdir: dir, theater: { dir, stem: "demo", files: {} }, stages: { tts: { outputs: {}, commands: [{ argv: ["t"] }] } } };
    writeFileSync(path.join(dir, "bridge.json"), JSON.stringify(stale));

    try {
      expect(() => readBridgeFile(dir)).toThrow(/still has a "tts" block.*start of "render"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
