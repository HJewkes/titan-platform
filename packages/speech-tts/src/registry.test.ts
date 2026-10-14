import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTtsConfig, type TtsProfile } from "./config.js";
import { TtsConfigError, TtsUnsupportedError } from "./errors.js";
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
  it("fails closed on an env-chosen provider that the profile does not define", () => {
    const select = () => defaultTtsRegistry().select(config({ TITAN_SPEECH_TTS: "gpu,plain" }));

    expect(select).toThrow(TtsConfigError);
    expect(select).toThrow("gpu is not configured in the profile");
  });

  const broken = (fallback?: boolean): TtsProfile => ({
    version: 1,
    tts: { ...(fallback !== undefined ? { fallback } : {}), providers: { gpu: { kind: "command", argv: [] }, ...profile.tts?.providers } },
  });

  // Mutation caught: a misconfigured preferred provider is skipped silently, and a weaker engine takes its place.
  it("fails closed on a misconfigured preferred provider, carrying the skipped reasons", () => {
    const error: unknown = (() => {
      try {
        defaultTtsRegistry().select(config({}, broken()));
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(TtsConfigError);
    expect(String(error)).toContain("gpu is misconfigured: tts.providers.gpu: argv must be a non-empty array");
    expect(String(error)).toContain("set tts.fallback: true");
    expect(error).toMatchObject({ code: "misconfigured", skipped: [{ id: "gpu", misconfigured: true }] });
  });

  // Mutations caught: tts.fallback is ignored; a factory's validation error escapes select.
  it("moves past a misconfigured provider when the profile sets fallback, saying why", () => {
    const { provider, skipped } = defaultTtsRegistry().select(config({}, broken(true)));

    expect(provider.id).toBe("plain");
    expect(skipped[0]?.reason).toMatch(/^is misconfigured: tts.providers.gpu: argv must be a non-empty array/);
  });

  // Mutation caught: a secret that resolves to nothing only marks the provider, and selection uses it anyway.
  it("fails closed, naming the variable, when a preferred provider's secret is unset", () => {
    const keyed: TtsProfile = {
      version: 1,
      tts: {
        providers: {
          hosted: { kind: "http", url: "https://tts.example.com", headers: { "x-api-key": "${env:HOSTED_KEY}" }, request: { body: {} }, capabilities: caps() },
          ...profile.tts?.providers,
        },
      },
    };

    expect(() => defaultTtsRegistry().select(config({}, keyed))).toThrow("hosted is misconfigured: headers.x-api-key needs env HOSTED_KEY");
  });

  // Mutation caught: register does not add the kind, so the next slice's Kokoro adapter cannot plug in.
  it("selects a kind registered by the caller, as the Kokoro adapter will be", () => {
    const withKokoro: TtsProfile = { version: 1, tts: { providers: { kokoro: { kind: "kokoro" } } } };
    const registry = createTtsRegistry();

    expect(() => registry.select(config({}, withKokoro))).toThrow('kokoro has kind "kokoro", which is not registered (registered: none)');
    registry.register("kokoro", (id) => fakeTts({ id }));
    expect(registry.select(config({}, withKokoro)).provider.id).toBe("kokoro");
  });

  // Mutations caught: an unknown kind is skipped like a capability gap; tts.fallback lets a typo fall through to the next,
  // remote, provider.
  it("refuses a mistyped kind with unknown-kind, naming the registered kinds, even with fallback set", () => {
    const typo: TtsProfile = {
      version: 1,
      tts: {
        fallback: true,
        providers: {
          local: { kind: "comand", argv: ["tts-cli"], capabilities: caps() },
          remote: { kind: "http", url: "https://tts.example.com/speak", request: { body: {} }, capabilities: caps() },
        },
      },
    };

    const error: unknown = (() => {
      try {
        return defaultTtsRegistry().select(config({}, typo));
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(TtsConfigError);
    expect(error).toMatchObject({ code: "unknown-kind", skipped: [{ id: "local", misconfigured: true }] });
    expect(String(error)).toContain('local has kind "comand", which is not registered (registered: command, http, fake)');
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
