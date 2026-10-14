import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTtsConfig, type TtsProfile } from "./config.js";
import { TtsUnavailableError, TtsUnsupportedError } from "./errors.js";
import { fakeTts } from "./fake-tts.js";
import { createTtsRegistry, defaultTtsRegistry, selectTts } from "./registry.js";

const caps = (extra: Record<string, unknown> = {}) => ({ voices: ["narrator"], sampleRate: 24_000, ...extra });

const profile: TtsProfile = {
  version: 1,
  tts: {
    providers: {
      plain: { kind: "fake", capabilities: caps() },
      timed: { kind: "fake", capabilities: caps({ wordTimestamps: true, phonemeInput: ["misaki"] }) },
    },
  },
};

const config = (env: Record<string, string> = {}, p: TtsProfile = profile) => resolveTtsConfig({ profile: p, env });

describe("provider selection", () => {
  // Mutation caught: select returns the first provider without checking requirements.
  it("falls back past a provider that lacks a required capability, saying why", () => {
    const { provider, skipped } = defaultTtsRegistry().select(config(), { wordTimestamps: true });

    expect(provider.id).toBe("timed");
    expect(skipped).toEqual([{ id: "plain", reason: "lacks word timestamps", missing: ["word timestamps"] }]);
  });

  // Mutation caught: the error drops the per-provider detail, leaving "no provider" with no way to act on it.
  it("fails with TtsUnsupportedError naming what each provider lacks", () => {
    const select = () => defaultTtsRegistry().select(config(), { voice: "af_heart", phonemeInput: "misaki" });

    expect(select).toThrow(TtsUnsupportedError);
    expect(select).toThrow('plain lacks phoneme input (misaki), voice "af_heart"; timed lacks voice "af_heart"');
  });

  // Mutation caught: an empty config returns undefined instead of saying how to configure one.
  it("fails with TtsUnavailableError pointing at the profile when nothing is configured", () => {
    expect(() => defaultTtsRegistry().select(resolveTtsConfig({ env: {} }))).toThrow(/no provider configured; add tts.providers/);
  });

  // Mutation caught: a TITAN_SPEECH_TTS id missing from the profile is silently ignored.
  it("reports an env-chosen provider that the profile does not define", () => {
    const select = () => defaultTtsRegistry().select(config({ TITAN_SPEECH_TTS: "gpu" }));

    expect(select).toThrow(TtsUnavailableError);
    expect(select).toThrow("gpu is not configured in the profile");
  });

  // Mutation caught: a factory's validation error escapes select instead of letting it fall back.
  it("skips a misconfigured provider and selects the next one", () => {
    const broken: TtsProfile = { version: 1, tts: { providers: { gpu: { kind: "command", argv: [] }, ...profile.tts?.providers } } };

    const { provider, skipped } = defaultTtsRegistry().select(config({}, broken));

    expect(provider.id).toBe("plain");
    expect(skipped[0]?.reason).toMatch(/^is misconfigured: tts.providers.gpu: argv must be a non-empty array/);
  });

  // Mutation caught: register does not add the kind, so the next slice's Kokoro adapter cannot plug in.
  it("selects a kind registered by the caller, as the Kokoro adapter will be", () => {
    const withKokoro: TtsProfile = { version: 1, tts: { providers: { kokoro: { kind: "kokoro" } } } };
    const registry = createTtsRegistry();

    expect(() => registry.select(config({}, withKokoro))).toThrow('kokoro has kind "kokoro", which is not registered');
    registry.register("kokoro", (id) => fakeTts({ id }));
    expect(registry.select(config({}, withKokoro)).provider.id).toBe("kokoro");
  });
});

describe("selectTts", () => {
  // Mutation caught: TITAN_SPEECH_PROFILE is not read, so a deployment cannot point at its profile.
  it("reads the profile named by TITAN_SPEECH_PROFILE and synthesizes with the selection", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "speech-tts-")), "profile.json");
    writeFileSync(path, JSON.stringify(profile));

    const { provider } = await selectTts({ env: { TITAN_SPEECH_PROFILE: path }, requirements: { phonemeInput: "misaki" } });
    const { words } = await provider.synthesize({ tokens: [{ text: "hi", phonemes: "hˈI" }], alphabet: "misaki" }, "narrator");

    expect(provider.id).toBe("timed");
    expect(words?.map((w) => w.word)).toEqual(["hi"]);
  });
});
