import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTtsProfile, parseTtsProfile, providerEnvName, resolveTtsConfig, type TtsProfile } from "./config.js";

const profile: TtsProfile = {
  version: 1,
  tts: {
    prefer: ["gpu"],
    providers: {
      laptop: { kind: "fake" },
      gpu: { kind: "command", argv: ["tts-cli"], timeoutMs: 1_000 },
      hosted: { kind: "http", url: "https://tts.example.com", headers: { authorization: "Bearer ${env:API_KEY}" } },
    },
  },
};

describe("resolveTtsConfig", () => {
  // Mutation caught: the profile's prefer list replaces the order, dropping unnamed providers.
  it("puts preferred providers first and keeps the rest in declaration order", () => {
    expect(resolveTtsConfig({ profile, env: {} }).order).toEqual(["gpu", "laptop", "hosted"]);
  });

  // Mutation caught: TITAN_SPEECH_TTS only reorders, so an explicit choice silently falls back to another engine.
  it("tries only the providers TITAN_SPEECH_TTS names, in its order", () => {
    expect(resolveTtsConfig({ profile, env: { TITAN_SPEECH_TTS: "hosted, laptop" } }).order).toEqual(["hosted", "laptop"]);
  });

  // Mutation caught: the profile value wins over the env override.
  it("lets env override a provider's url, argv and timeout", () => {
    const env = {
      [providerEnvName("gpu", "ARGV")]: '["ssh","gpu-box","tts-cli"]',
      [providerEnvName("gpu", "TIMEOUT_MS")]: "5000",
      [providerEnvName("hosted", "URL")]: "http://127.0.0.1:9000/speak",
      API_KEY: "k",
    };

    const { providers } = resolveTtsConfig({ profile, env });

    expect(providers.gpu).toMatchObject({ argv: ["ssh", "gpu-box", "tts-cli"], timeoutMs: 5_000 });
    expect(providers.hosted).toMatchObject({ url: "http://127.0.0.1:9000/speak", headers: { authorization: "Bearer k" } });
  });

  // Mutation caught: a missing secret expands to an empty string and the provider is used anyway.
  it("marks a provider unusable, naming the variable, when a header secret is unset", () => {
    expect(resolveTtsConfig({ profile, env: {} }).unusable).toEqual({ hosted: "headers.authorization needs env API_KEY, which is unset or empty" });
  });

  // Mutation caught: only unset variables are checked, so an empty one sends "Bearer " with no key.
  it("treats an empty secret like an unset one, never sending an empty header", () => {
    expect(resolveTtsConfig({ profile, env: { API_KEY: "" } }).unusable.hosted).toMatch(/needs env API_KEY/);
  });

  // Mutations caught: command env values are not expanded; expanded values are not handed on for redaction.
  it("expands secrets in a command's env and hands every expanded value on as secrets", () => {
    const withEnv: TtsProfile = { version: 1, tts: { providers: { gpu: { kind: "command", argv: ["x"], env: { TOKEN: "${env:GPU_TOKEN}" } } } } };

    const { providers, unusable } = resolveTtsConfig({ profile: withEnv, env: { GPU_TOKEN: "t0ken-value" } });

    expect(providers.gpu).toMatchObject({ env: { TOKEN: "t0ken-value" }, secrets: ["t0ken-value"] });
    expect(unusable).toEqual({});
  });

  it("rejects an argv override that is not JSON, naming the variable", () => {
    const env = { [providerEnvName("gpu", "ARGV")]: "ssh gpu-box" };

    expect(() => resolveTtsConfig({ profile, env })).toThrow(/TITAN_SPEECH_TTS_GPU_ARGV must be a JSON array/);
  });

  it("resolves to no providers with neither a profile nor env", () => {
    expect(resolveTtsConfig({ env: {} })).toEqual({ order: [], providers: {}, unusable: {}, fallback: false });
  });
});

describe("profile files", () => {
  // Mutation caught: a missing profile throws, so a host with no profile cannot start.
  it("treats a missing file as no profile", async () => {
    await expect(loadTtsProfile(join(mkdtempSync(join(tmpdir(), "speech-tts-")), "absent.json"))).resolves.toBeUndefined();
  });

  it("names the file and the field when a profile is malformed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "speech-tts-")), "profile.json");
    writeFileSync(path, JSON.stringify({ version: 1, tts: { providers: { gpu: { argv: [] } } } }));

    await expect(loadTtsProfile(path)).rejects.toThrow(`${path}: tts.providers.gpu needs a string "kind"`);
  });

  it("rejects a document without version 1", () => {
    expect(() => parseTtsProfile({ tts: {} })).toThrow(/version/);
  });
});
