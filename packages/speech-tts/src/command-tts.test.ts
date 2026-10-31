import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { commandTts, type CommandTtsOptions } from "./command-tts.js";
import { runTtsConformance } from "./conformance.js";
import { TtsFailedError, TtsTimeoutError, TtsUnavailableError } from "./errors.js";
import { defaultTtsRegistry } from "./registry.js";
import { resolveTtsConfig } from "./config.js";
import { encodeWav } from "./wav.js";
import type { TtsCapabilities } from "./types.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-tts.mjs", import.meta.url));
const stub = (...flags: string[]): string[] => [process.execPath, STUB, ...flags];

const TEXT_ONLY: TtsCapabilities = {
  phonemeInput: [],
  wordTimestamps: false,
  speedControl: false,
  voices: [{ id: "narrator", languages: ["en-US"] }],
  languages: ["en-US"],
  sampleRate: 24_000,
};
const FULL: TtsCapabilities = { ...TEXT_ONLY, phonemeInput: ["ipa"], wordTimestamps: true, speedControl: true, sampleRate: 22_050 };

const provider = (argv: string[], extra: Partial<CommandTtsOptions> = {}) =>
  commandTts({ id: "stub", argv, capabilities: TEXT_ONLY, output: "stdout-wav", ...extra });

const scratch = (): string => mkdtempSync(join(tmpdir(), "speech-tts-test-"));

// Mutations caught: the deadline never kills the child (hung case), ENOENT surfaces as a raw spawn error.
runTtsConformance("commandTts stdout-wav, text only", {
  working: () => provider(stub("--mode", "stdout-wav")),
  unavailable: () => provider(["/nonexistent/speech-engine"]),
  hung: () => provider(stub("--mode", "hang")),
});

// Mutations caught: JSON words or the `wav` path ignored; speed not forwarded in the request.
runTtsConformance("commandTts json, full capabilities", {
  working: () => provider(stub("--mode", "json-path", "--rate", "22050"), { output: "json", capabilities: FULL }),
  unavailable: () => provider(stub("--mode", "unavailable"), { output: "json", capabilities: FULL }),
  hung: () => provider(stub("--mode", "hang"), { output: "json", capabilities: FULL }),
});

describe("commandTts", () => {
  // Mutation caught: the header rate is ignored and the declared 24 kHz assumed.
  it("takes the sample rate from the WAV header the command writes", async () => {
    const tts = provider(stub("--mode", "stdout-wav", "--rate", "16000"));

    const { audio, durationS } = await tts.synthesize({ text: "one two" }, "narrator");

    expect(audio.sampleRate).toBe(16_000);
    expect(durationS).toBeCloseTo(0.8, 3);
  });

  // Mutation caught: the abort listener that kills the process group is dropped.
  it("kills the child when the deadline passes", async () => {
    const pidFile = join(scratch(), "pid");
    const tts = provider(stub("--mode", "hang", "--pid-file", pidFile));

    await expect(tts.synthesize({ text: "hi" }, "narrator", { timeoutMs: 300 })).rejects.toBeInstanceOf(TtsTimeoutError);

    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
  });

  // Mutation caught: stderr is dropped from the error.
  it("rejects a non-zero exit with TtsFailedError carrying the command's stderr", async () => {
    const error = await provider(stub("--mode", "fail")).synthesize({ text: "hi" }, "narrator").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).toContain("voice model failed to load");
  });

  // Mutation caught: every non-zero exit is reported as a failure, so selection cannot tell a down engine.
  it("reports exit 69 as TtsUnavailableError", async () => {
    await expect(provider(stub("--mode", "unavailable")).synthesize({ text: "hi" }, "narrator")).rejects.toBeInstanceOf(TtsUnavailableError);
  });

  // Mutation caught: a non-WAV stdout is passed through as empty audio.
  it("rejects stdout that is not a WAV with TtsFailedError", async () => {
    await expect(provider(stub("--mode", "garbage")).synthesize({ text: "hi" }, "narrator")).rejects.toBeInstanceOf(TtsFailedError);
  });

  // Mutation caught: tokens are flattened to text before they reach the engine, losing their phonemes.
  it("writes the documented request, with tokens and their alphabet, to stdin", async () => {
    const echo = join(scratch(), "request.json");
    const tts = provider(stub("--mode", "json-base64", "--echo", echo), { output: "json", capabilities: FULL });

    const result = await tts.synthesize({ tokens: [{ text: "live", phonemes: "lˈIv" }], alphabet: "ipa" }, "narrator", { speed: 1.2 });

    const request = readJson(echo);
    expect(request).toMatchObject({ version: 1, voice: "narrator", alphabet: "ipa", speed: 1.2, tokens: [{ text: "live", phonemes: "lˈIv" }] });
    expect(request).not.toHaveProperty("text");
    expect(result.phonemes).toEqual(["lˈIv"]);
  });

  // Mutation caught: engine timings pass through although the provider does not declare word timestamps.
  it("drops word timings the engine sends when the provider does not declare them", async () => {
    const tts = provider(stub("--mode", "json-base64"), { output: "json" });

    const result = await tts.synthesize({ text: "one two" }, "narrator");

    expect(result.words).toBeUndefined();
    expect(result.durationS).toBeCloseTo(0.8, 3);
  });

  // Mutation caught: the per-call scratch directory is never removed.
  it("removes the scratch WAV it offered the command as `out`", async () => {
    const echo = join(scratch(), "request.json");
    const tts = provider(stub("--mode", "json-path", "--echo", echo), { output: "json" });

    await tts.synthesize({ text: "hi" }, "narrator");

    const { out } = readJson(echo);
    expect(typeof out).toBe("string");
    expect(existsSync(String(out))).toBe(false);
  });
});

describe("commandTts hardening", () => {
  afterEach(() => {
    delete process.env.SPEECH_TTS_TEST_LEAK;
  });

  // Mutation caught: stdout is counted only once the command exits, so an endless stream runs to the deadline.
  it("kills a command whose stdout passes maxOutputBytes, while it is still writing", async () => {
    const pidFile = join(scratch(), "pid");
    const tts = provider(stub("--mode", "flood", "--pid-file", pidFile), { maxOutputBytes: 2 * 1024 * 1024 });
    const started = Date.now();

    const error = await tts.synthesize({ text: "hi" }, "narrator", { timeoutMs: 20_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).toContain("stdout passed maxOutputBytes (2097152)");
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect.poll(() => isAlive(Number(readFileSync(pidFile, "utf8"))), { timeout: 2_000 }).toBe(false);
  });

  // Mutation caught: the factory drops maxOutputBytes, so a profile cannot lower the limit.
  it("takes maxOutputBytes from the profile", async () => {
    const config = resolveTtsConfig({
      env: {},
      profile: { version: 1, tts: { providers: { gpu: { kind: "command", argv: stub("--mode", "flood"), output: "stdout-wav", maxOutputBytes: 1_048_576, capabilities: { voices: ["narrator"], sampleRate: 24_000 } } } } },
    });

    const { provider: tts } = defaultTtsRegistry().select(config);

    await expect(tts.synthesize({ text: "hi" }, "narrator", { timeoutMs: 20_000 })).rejects.toThrow("maxOutputBytes (1048576)");
  });

  // Mutation caught: the child gets the whole parent environment, API keys included.
  it("gives the child only PATH, HOME, LANG, TMPDIR and its configured env", async () => {
    process.env.SPEECH_TTS_TEST_LEAK = "parent-secret";
    const envFile = join(scratch(), "env.json");
    const tts = provider(stub("--mode", "env", "--dump-env", envFile), { env: { ENGINE_MODEL: "small" } });

    await tts.synthesize({ text: "hi" }, "narrator");

    const childEnv = readJson(envFile);
    expect(childEnv).not.toHaveProperty("SPEECH_TTS_TEST_LEAK");
    expect(childEnv).toMatchObject({ ENGINE_MODEL: "small", PATH: process.env.PATH });
    expect(Object.keys(childEnv).filter((k) => !["PATH", "HOME", "LANG", "TMPDIR", "ENGINE_MODEL"].includes(k))).toEqual([]);
  });

  // Mutations caught: stderr is quoted unredacted; stderr is quoted whole, however long.
  it("redacts configured secrets from stderr and quotes at most about 2 KB of it", async () => {
    const tts = provider(stub("--mode", "secret-stderr"), { env: { STUB_TOKEN: "s3cr3t-token" }, secrets: ["s3cr3t-token"] });

    const error = await tts.synthesize({ text: "hi" }, "narrator").catch((e: unknown) => e);

    expect(String(error)).not.toContain("s3cr3t-token");
    expect(String(error)).toContain("auth failed for token [redacted] near the end");
    expect(String(error).length).toBeLessThan(2_200);
  });

  // Mutation caught: expanding `${env:}` values replaces the profile's own `secrets` list, so a literal secret leaks.
  it("redacts a literal secret the profile declares, alongside expanded ones", async () => {
    const config = resolveTtsConfig({
      env: { OTHER_TOKEN: "expanded-value" },
      profile: {
        version: 1,
        tts: {
          providers: {
            gpu: {
              kind: "command",
              argv: stub("--mode", "secret-stderr"),
              output: "stdout-wav",
              env: { STUB_TOKEN: "lit3ral-secret", OTHER: "${env:OTHER_TOKEN}" },
              secrets: ["lit3ral-secret"],
              capabilities: { voices: ["narrator"], sampleRate: 24_000 },
            },
          },
        },
      },
    });
    const { provider: tts } = defaultTtsRegistry().select(config);

    const error = await tts.synthesize({ text: "hi" }, "narrator").catch((e: unknown) => e);

    expect(String(error)).toContain("auth failed for token [redacted] near the end");
    expect(String(error)).not.toContain("lit3ral-secret");
  });

  // Mutation caught: an absolute `wav` path is read as given.
  it("refuses an absolute wav path", async () => {
    const tts = provider(stub("--mode", "json-absolute"), { output: "json" });

    await expect(tts.synthesize({ text: "hi" }, "narrator")).rejects.toThrow(/must be a path relative to outDir, not absolute/);
  });

  // Mutation caught: a `..` path is resolved and read from outside outDir.
  it("refuses a wav path that escapes outDir with ..", async () => {
    const echo = join(scratch(), "request.json");
    const tts = provider(stub("--mode", "json-escape", "--echo", echo), { output: "json" });

    const error = await tts.synthesize({ text: "hi" }, "narrator").catch((e: unknown) => e);
    rmSync(join(dirname(String(readJson(echo).outDir)), "outside.wav"), { force: true });

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).toContain('wav "../outside.wav" must be a bare filename');
  });

  // Mutation caught: a nested path is accepted, so a directory swapped in for the subdirectory can reach outside outDir.
  it("refuses a wav path that has a directory part, even inside outDir", async () => {
    const tts = provider(stub("--mode", "json-subdir"), { output: "json" });

    await expect(tts.synthesize({ text: "hi" }, "narrator")).rejects.toThrow('wav "sub/out.wav" must be a bare filename');
  });

  // Mutation caught: the path is checked before symlinks are resolved, so a link inside outDir reads any file.
  it("refuses a wav that is a symlink out of outDir", async () => {
    const target = join(scratch(), "elsewhere.wav");
    writeFileSync(target, encodeWav({ samples: new Float32Array(2_400), sampleRate: 24_000 }));
    const tts = provider(stub("--mode", "json-symlink", "--target", target), { output: "json" });

    await expect(tts.synthesize({ text: "hi" }, "narrator")).rejects.toThrow('wav "link.wav" links outside outDir');
  });

  // Mutation caught: the named WAV file is read whole, whatever maxOutputBytes says.
  it("refuses a named wav file larger than maxOutputBytes", async () => {
    const tts = provider(stub("--mode", "json-path"), { output: "json", maxOutputBytes: 4_096 });

    await expect(tts.synthesize({ text: "a b c" }, "narrator")).rejects.toThrow("is larger than maxOutputBytes (4096)");
  });
});

function readJson(path: string): Record<string, unknown> {
  const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(doc)) throw new Error(`${path} is not a JSON object`);
  return doc;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
