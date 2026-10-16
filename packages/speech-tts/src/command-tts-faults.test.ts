import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import type * as ChildProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandTts } from "./command-tts.js";
import { TtsFailedError } from "./errors.js";
import type { TtsCapabilities } from "./types.js";

const hooks = vi.hoisted(() => ({ rmFails: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (hooks.rmFails) throw new Error("EBUSY: scratch directory is locked");
      return actual.rm(...args);
    }),
  };
});

const STUB = fileURLToPath(new URL("./fixtures/stub-tts.mjs", import.meta.url));
const CAPS: TtsCapabilities = {
  phonemeInput: [],
  wordTimestamps: false,
  speedControl: false,
  voices: [{ id: "narrator", languages: ["en-US"] }],
  languages: ["en-US"],
  sampleRate: 24_000,
};
const provider = (mode: string, output: "json" | "stdout-wav") =>
  commandTts({ id: "stub", argv: [process.execPath, STUB, "--mode", mode], capabilities: CAPS, output });

const originalTmpdir = process.env.TMPDIR;
let scratchRoot = "";

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  hooks.rmFails = false;
  scratchRoot = mkdtempSync(join(tmpdir(), "speech-tts-faults-"));
  process.env.TMPDIR = scratchRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("commandTts faults", () => {
  // Mutation caught: the scratch-dir rm error in finally replaces the synthesis result.
  it("returns the audio and logs a warning when removing the scratch directory fails", async () => {
    hooks.rmFails = true;
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const result = await provider("json-path", "json").synthesize({ text: "hi" }, "narrator");

    expect(result.audio.sampleRate).toBe(24_000);
    expect(String(warn.mock.calls[0]?.[0])).toContain("EBUSY");
  });

  // Mutation caught: the rm error in finally replaces the real synthesis failure.
  it("keeps the synthesis error when removing the scratch directory also fails", async () => {
    hooks.rmFails = true;
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const error = await provider("fail", "json").synthesize({ text: "hi" }, "narrator").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).toContain("voice model failed to load");
  });

  // Mutation caught: run attaches its abort listener late, so a signal aborted before the call is never seen.
  it("rejects without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));

    const outcome = provider("hang", "stdout-wav").synthesize({ text: "hi" }, "narrator", { signal: controller.signal });

    await expect(outcome).rejects.toThrow("caller gave up");
    expect(spawn).not.toHaveBeenCalled();
  });
});
