import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SpeechEnv, TtsProfile } from "./config.js";
import {
  detectSpeechRuntime,
  runtimeOptions,
  SPEECH_CACHE_ENV,
  SPEECH_DEVICE_ENV,
  speechDeviceEnvName,
  SpeechRuntimeError,
  type SpeechDevice,
  type SpeechRuntime,
  type SpeechRuntimeInput,
} from "./runtime.js";

// Joined from segments, as app-paths' tests do, so no literal home path is committed.
const MAC_HOME = path.posix.join("/", "Users", "tester");
const SPACED_HOME = path.posix.join("/", "Users", "Test User");
const LINUX_HOME = path.posix.join("/", "home", "tester");
const ORT = `${LINUX_HOME}/peers/node_modules/onnxruntime-node`;
const CUDA_LIB = `${ORT}/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so`;
const DRIVER = "/proc/driver/nvidia/version";

const existing =
  (...paths: string[]) =>
  (p: string): boolean =>
    new Set(paths).has(p);

const mac = (overrides: Partial<SpeechRuntimeInput> = {}): SpeechRuntimeInput => ({
  platform: "darwin",
  arch: "arm64",
  env: {},
  home: MAC_HOME,
  exists: existing(),
  ...overrides,
});

const cudaBox = (overrides: Partial<SpeechRuntimeInput> = {}): SpeechRuntimeInput => ({
  platform: "linux",
  arch: "x64",
  env: {},
  home: LINUX_HOME,
  exists: existing(CUDA_LIB, DRIVER),
  ortDir: ORT,
  ...overrides,
});

const allCpu: Record<string, SpeechDevice> = { tts: "cpu", stt: "cpu", phones: "cpu" };

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof SpeechRuntimeError ? error.code : `not a SpeechRuntimeError: ${String(error)}`;
  }
  return undefined;
};

describe("detectSpeechRuntime defaults", () => {
  it("uses cpu and the per-user cache on an arm64 Mac with no configuration", () => {
    const rt = detectSpeechRuntime(mac());

    expect(rt.device).toEqual(allCpu);
    expect(rt.available).toEqual(["cpu"]);
    expect(rt.source).toEqual({ device: { tts: "default", stt: "default", phones: "default" }, cacheDir: "default" });
    expect(rt.cacheDir).toBe(`${MAC_HOME}/Library/Caches/titan-speech`);
  });

  // Mutation caught: cuda being listed also selects it.
  it("lists cuda on linux-x64 with the ORT CUDA library and the driver, but still uses cpu", () => {
    const rt = detectSpeechRuntime(cudaBox());

    expect(rt.device).toEqual(allCpu);
    expect(rt.available).toEqual(["cpu", "cuda"]);
  });

  it.each([
    ["the CUDA library is missing", cudaBox({ exists: existing(DRIVER) })],
    ["the driver is missing", cudaBox({ exists: existing(CUDA_LIB) })],
    ["onnxruntime-node was not found", cudaBox({ ortDir: undefined })],
    ["the host is linux-arm64", cudaBox({ arch: "arm64" })],
  ])("does not list cuda when %s", (_, input) => {
    expect(detectSpeechRuntime(input).available).toEqual(["cpu"]);
  });

  it("refuses a darwin-x64 Node before reading any override", () => {
    const env = { [SPEECH_DEVICE_ENV]: "cpu", [speechDeviceEnvName("stt")]: "cpu" };

    expect(() => detectSpeechRuntime(mac({ arch: "x64", env }))).toThrow(/run an arm64 Node/);
    expect(codeOf(() => detectSpeechRuntime(mac({ arch: "x64" })))).toBe("unsupported-platform");
  });

  it("reports offline from TITAN_SPEECH_OFFLINE", () => {
    expect(detectSpeechRuntime(mac({ env: { TITAN_SPEECH_OFFLINE: "1" } })).offline).toBe(true);
    expect(detectSpeechRuntime(mac({ env: {} })).offline).toBe(false);
  });
});

describe("detectSpeechRuntime device overrides", () => {
  // Mutation caught: every component resolves from TITAN_SPEECH_DEVICE alone, so this cuda never reaches validation.
  it("refuses TITAN_SPEECH_DEVICE_STT=cuda on a Mac and names the variable", () => {
    const run = () => detectSpeechRuntime(mac({ env: { TITAN_SPEECH_DEVICE_STT: "cuda" } }));

    expect(codeOf(run)).toBe("unsupported-device");
    expect(run).toThrow(/TITAN_SPEECH_DEVICE_STT=cuda: cuda needs linux-x64; this is darwin-arm64/);
  });

  // Mutation caught: the per-component override is ignored, so stt follows TITAN_SPEECH_DEVICE to cpu.
  it("lets TITAN_SPEECH_DEVICE_STT beat TITAN_SPEECH_DEVICE for stt only", () => {
    const env = { TITAN_SPEECH_DEVICE: "cpu", TITAN_SPEECH_DEVICE_STT: "cuda" };

    const rt = detectSpeechRuntime(cudaBox({ env, allowUnverifiedCuda: true }));

    expect(rt.device).toEqual({ tts: "cpu", stt: "cuda", phones: "cpu" });
    expect(rt.source.device.stt).toBe("env");
  });

  it("refuses an available cuda as unverified until E9 without the opt-in", () => {
    const run = () => detectSpeechRuntime(cudaBox({ env: { TITAN_SPEECH_DEVICE: "cpu", TITAN_SPEECH_DEVICE_STT: "cuda" } }));

    expect(codeOf(run)).toBe("unverified-device");
    expect(run).toThrow(/unverified until spike E9; unset TITAN_SPEECH_DEVICE_STT to use cpu/);
  });

  it("refuses cuda on linux-x64 when the driver is missing, naming the path", () => {
    const run = () => detectSpeechRuntime(cudaBox({ env: { TITAN_SPEECH_DEVICE: "cuda" }, exists: existing(CUDA_LIB) }));

    expect(codeOf(run)).toBe("unavailable-device");
    expect(run).toThrow(`TITAN_SPEECH_DEVICE=cuda: cuda is not available here; missing ${DRIVER}`);
  });

  it("refuses an unknown device", () => {
    expect(codeOf(() => detectSpeechRuntime(mac({ env: { TITAN_SPEECH_DEVICE: "tpu" } })))).toBe("unknown-device");
  });

  it.each(["coreml", "webgpu"])("refuses %s as needing transformers 4.x", (device) => {
    const run = () => detectSpeechRuntime(mac({ env: { TITAN_SPEECH_DEVICE_TTS: device } }));

    expect(codeOf(run)).toBe("unsupported-device");
    expect(run).toThrow(/4\.x/);
  });

  it("treats an empty per-component variable as unset", () => {
    const rt = detectSpeechRuntime(mac({ env: { TITAN_SPEECH_DEVICE_STT: "" } }));

    expect(rt.source.device.stt).toBe("default");
  });
});

describe("detectSpeechRuntime cache", () => {
  it("returns a TITAN_SPEECH_CACHE with spaces byte for byte", () => {
    const cache = `${SPACED_HOME}/Library/Application Support/titan speech`;

    const rt = detectSpeechRuntime(mac({ env: { [SPEECH_CACHE_ENV]: cache } }));

    expect(rt.cacheDir).toBe(cache);
    expect(rt.source.cacheDir).toBe("env");
  });

  it("keeps a home with a space in the default cache", () => {
    expect(detectSpeechRuntime(mac({ home: SPACED_HOME })).cacheDir).toBe(`${SPACED_HOME}/Library/Caches/titan-speech`);
  });

  it("follows XDG_CACHE_HOME on linux", () => {
    expect(detectSpeechRuntime(cudaBox({ env: { XDG_CACHE_HOME: "/tmp/xdg" } })).cacheDir).toBe("/tmp/xdg/titan-speech");
  });

  it.each(["~/c", "rel/c"])("refuses the non-absolute cache %s", (cache) => {
    expect(codeOf(() => detectSpeechRuntime(mac({ env: { TITAN_SPEECH_CACHE: cache } })))).toBe("bad-cache-dir");
  });

  it("falls back to the default when TITAN_SPEECH_CACHE is empty", () => {
    const rt = detectSpeechRuntime(mac({ env: { TITAN_SPEECH_CACHE: "" } }));

    expect(rt.cacheDir).toBe(`${MAC_HOME}/Library/Caches/titan-speech`);
    expect(rt.source.cacheDir).toBe("default");
  });
});

describe("detectSpeechRuntime profile", () => {
  const withRuntime = (runtime: TtsProfile["runtime"]): TtsProfile => ({ version: 1, runtime });

  it("takes a device and the cache from the profile's runtime section", () => {
    const rt = detectSpeechRuntime(mac({ profile: withRuntime({ device: { phones: "cpu" }, cacheDir: "/Volumes/Models/cache" }) }));

    expect(rt.source.device.phones).toBe("profile");
    expect(rt.cacheDir).toBe("/Volumes/Models/cache");
    expect(rt.source.cacheDir).toBe("profile");
  });

  // Mutation caught: the profile is read before the env.
  it("lets env beat the profile", () => {
    const env: SpeechEnv = { TITAN_SPEECH_DEVICE_TTS: "cpu", TITAN_SPEECH_CACHE: "/tmp/env-cache" };

    const rt = detectSpeechRuntime(mac({ env, profile: withRuntime({ device: { tts: "webgpu" }, cacheDir: "/tmp/profile-cache" }) }));

    expect(rt.source.device.tts).toBe("env");
    expect(rt.cacheDir).toBe("/tmp/env-cache");
  });

  it("names the profile field when its device is invalid", () => {
    const run = () => detectSpeechRuntime(mac({ profile: withRuntime({ device: { tts: "tpu" } }) }));

    expect(run).toThrow(/^profile runtime\.device\.tts=tpu: unknown device/);
  });
});

describe("runtimeOptions", () => {
  it("gives one component's device with the shared cache", () => {
    const rt: SpeechRuntime = detectSpeechRuntime(cudaBox({ env: { TITAN_SPEECH_DEVICE_PHONES: "cuda" }, allowUnverifiedCuda: true }));

    expect(runtimeOptions(rt, "phones")).toEqual({ device: "cuda", cacheDir: `${LINUX_HOME}/.cache/titan-speech` });
    expect(runtimeOptions(rt, "tts")).toEqual({ device: "cpu", cacheDir: `${LINUX_HOME}/.cache/titan-speech` });
  });
});
