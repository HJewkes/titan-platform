import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandTts, type CommandTtsOptions } from "./command-tts.js";
import { runTtsConformance } from "./conformance.js";
import { TtsFailedError, TtsTimeoutError, TtsUnavailableError } from "./errors.js";
import { isRecord } from "./guards.js";
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
