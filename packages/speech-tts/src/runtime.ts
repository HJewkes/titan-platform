import path from "node:path";
import { appDirs } from "@titan-design/app-paths";
import { type SpeechComponent, type SpeechEnv, type TtsProfile } from "./config.js";

/** The transformers.js device names P1 knows. Only `cpu` is used without an explicit, verified opt-in. */
export type SpeechDevice = "cpu" | "cuda" | "coreml" | "webgpu";

type Source = "env" | "profile" | "default";

export interface SpeechRuntime {
  device: Readonly<Record<SpeechComponent, SpeechDevice>>;
  /** Devices this host could run. Listing `cuda` does not select it. */
  available: readonly SpeechDevice[];
  cacheDir: string;
  offline: boolean;
  /** Where each value came from, so a caller can let an env choice beat its own default. */
  source: { device: Readonly<Record<SpeechComponent, Source>>; cacheDir: Source };
}

export interface SpeechRuntimeInput {
  platform: NodeJS.Platform;
  arch: string;
  env: SpeechEnv;
  home: string;
  exists: (path: string) => boolean;
  /** The onnxruntime-node package directory, when one was found. Without it, cuda is never available. */
  ortDir?: string;
  profile?: TtsProfile;
  /** Lets an explicit cuda choice through before spike E9 has verified it. */
  allowUnverifiedCuda?: boolean;
}

type SpeechRuntimeErrorCode =
  | "unknown-device"
  | "unsupported-device"
  | "unavailable-device"
  | "unverified-device"
  | "unsupported-platform"
  | "bad-cache-dir";

export class SpeechRuntimeError extends Error {
  constructor(
    readonly code: SpeechRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpeechRuntimeError";
  }
}

export const SPEECH_DEVICE_ENV = "TITAN_SPEECH_DEVICE";
export const SPEECH_CACHE_ENV = "TITAN_SPEECH_CACHE";

/** `TITAN_SPEECH_DEVICE_<TTS|STT|PHONES>`: one component's device, which beats `TITAN_SPEECH_DEVICE`. */
export const speechDeviceEnvName = (component: SpeechComponent): string => `${SPEECH_DEVICE_ENV}_${component.toUpperCase()}`;

const KNOWN_DEVICES: readonly SpeechDevice[] = ["cpu", "cuda", "coreml", "webgpu"];
// The layout of onnxruntime-node 1.21, the version transformers 3.x pulls in; 1.30 moved to napi-v6.
const CUDA_PROVIDER_LIB = path.posix.join("bin", "napi-v3", "linux", "x64", "libonnxruntime_providers_cuda.so");
const NVIDIA_DRIVER = "/proc/driver/nvidia/version";

interface Choice {
  value: string;
  source: Source;
  /** The variable or profile field that set the value, for error messages. */
  name: string;
}

function cudaMissing(input: SpeechRuntimeInput): string[] {
  const lib = input.ortDir === undefined ? undefined : path.posix.join(input.ortDir, CUDA_PROVIDER_LIB);
  return [
    ...(lib === undefined ? [`onnxruntime-node/${CUDA_PROVIDER_LIB} (onnxruntime-node not found)`] : input.exists(lib) ? [] : [lib]),
    ...(input.exists(NVIDIA_DRIVER) ? [] : [NVIDIA_DRIVER]),
  ];
}

const isLinuxX64 = (input: SpeechRuntimeInput): boolean => input.platform === "linux" && input.arch === "x64";

function availableDevices(input: SpeechRuntimeInput): SpeechDevice[] {
  return isLinuxX64(input) && cudaMissing(input).length === 0 ? ["cpu", "cuda"] : ["cpu"];
}

function assertPlatform(input: SpeechRuntimeInput): void {
  if (input.platform !== "darwin" || input.arch !== "x64") return;
  throw new SpeechRuntimeError(
    "unsupported-platform",
    "speech models need an arm64 Node on macOS (this Node is x64: Rosetta or an Intel Mac); run an arm64 Node",
  );
}

// Empty strings count as unset, as they do for the other TITAN_SPEECH_* variables.
function chooseDevice(component: SpeechComponent, input: SpeechRuntimeInput): Choice {
  const own = speechDeviceEnvName(component);
  if (input.env[own]) return { value: input.env[own], source: "env", name: own };
  const shared = input.env[SPEECH_DEVICE_ENV];
  if (shared) return { value: shared, source: "env", name: SPEECH_DEVICE_ENV };
  const profiled = input.profile?.runtime?.device?.[component];
  if (profiled) return { value: profiled, source: "profile", name: `profile runtime.device.${component}` };
  return { value: "cpu", source: "default", name: "default" };
}

function checkCuda(label: string, choice: Choice, input: SpeechRuntimeInput): void {
  if (!isLinuxX64(input)) {
    throw new SpeechRuntimeError("unsupported-device", `${label}: cuda needs linux-x64; this is ${input.platform}-${input.arch}`);
  }
  const missing = cudaMissing(input);
  if (missing.length > 0) {
    throw new SpeechRuntimeError("unavailable-device", `${label}: cuda is not available here; missing ${missing.join(", ")}`);
  }
  if (input.allowUnverifiedCuda) return;
  throw new SpeechRuntimeError("unverified-device", `${label}: cuda is unverified until spike E9; unset ${choice.name} to use cpu`);
}

function validateDevice(choice: Choice, input: SpeechRuntimeInput): SpeechDevice {
  const label = `${choice.name}=${choice.value}`;
  const device = KNOWN_DEVICES.find((d) => d === choice.value);
  if (device === undefined) {
    throw new SpeechRuntimeError("unknown-device", `${label}: unknown device; expected one of ${KNOWN_DEVICES.join(", ")}`);
  }
  if (device === "coreml" || device === "webgpu") {
    throw new SpeechRuntimeError("unsupported-device", `${label}: ${device} needs @huggingface/transformers 4.x; speech packages support 3.x`);
  }
  if (device === "cuda") checkCuda(label, choice, input);
  return device;
}

function checkCacheDir(name: string, cacheDir: string, platform: NodeJS.Platform): void {
  const isAbsolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (isAbsolute(cacheDir)) return;
  throw new SpeechRuntimeError("bad-cache-dir", `${name}=${cacheDir}: use an absolute path; the shell did not expand ~`);
}

// The path is passed through untouched: a cache under "Application Support" must survive with its space.
function chooseCacheDir(input: SpeechRuntimeInput): { cacheDir: string; source: Source } {
  const fromEnv = input.env[SPEECH_CACHE_ENV];
  if (fromEnv) {
    checkCacheDir(SPEECH_CACHE_ENV, fromEnv, input.platform);
    return { cacheDir: fromEnv, source: "env" };
  }
  const fromProfile = input.profile?.runtime?.cacheDir;
  if (fromProfile) {
    checkCacheDir("profile runtime.cacheDir", fromProfile, input.platform);
    return { cacheDir: fromProfile, source: "profile" };
  }
  const { cache } = appDirs("titan-speech", { env: input.env, home: input.home, platform: input.platform });
  return { cacheDir: cache, source: "default" };
}

// Spelled out per key, in tts, stt, phones order, so the record is complete by type and validation order is fixed.
const perComponent = <T>(pick: (component: SpeechComponent) => T): Record<SpeechComponent, T> => ({
  tts: pick("tts"),
  stt: pick("stt"),
  phones: pick("phones"),
});

/**
 * Picks each speech model's device and the model cache from the platform, `TITAN_SPEECH_*` env and the profile's
 * `runtime` section. Pure: the host is passed in. Per component, `TITAN_SPEECH_DEVICE_<C>` beats
 * `TITAN_SPEECH_DEVICE`, which beats the profile, which beats `cpu`.
 */
export function detectSpeechRuntime(input: SpeechRuntimeInput): SpeechRuntime {
  assertPlatform(input);
  const choices = perComponent((c) => chooseDevice(c, input));
  const device = perComponent((c) => validateDevice(choices[c], input));
  const cache = chooseCacheDir(input);
  return {
    device,
    available: availableDevices(input),
    cacheDir: cache.cacheDir,
    offline: Boolean(input.env.TITAN_SPEECH_OFFLINE),
    source: { device: perComponent((c) => choices[c].source), cacheDir: cache.source },
  };
}

/** The `{ device, cacheDir }` options one component's provider takes: Kokoro, Whisper or wav2vec2. */
export function runtimeOptions(runtime: SpeechRuntime, component: SpeechComponent): { device: SpeechDevice; cacheDir: string } {
  return { device: runtime.device[component], cacheDir: runtime.cacheDir };
}
