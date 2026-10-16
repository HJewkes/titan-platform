import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { loadTtsProfile, PROFILE_ENV, type SpeechEnv } from "./config.js";
import { packageDir } from "./package-dir.js";
import { detectSpeechRuntime, type SpeechRuntime } from "./runtime.js";

const TRANSFORMERS_PEER = "@huggingface/transformers";
const ORT = "onnxruntime-node";

export interface ResolveSpeechRuntimeOptions {
  /** Defaults to `process.env`. */
  env?: SpeechEnv;
  /** Falls back to `TITAN_SPEECH_PROFILE`. With neither, only env and defaults apply. */
  profilePath?: string;
  allowUnverifiedCuda?: boolean;
  /** Injectable for tests; defaults to looking for onnxruntime-node beside the transformers.js peer. */
  findOrtDir?: () => string | undefined;
}

// onnxruntime-node is a dependency of the transformers.js peer, so it resolves from there under pnpm and npm alike.
// The peer is optional: an absent or odd install means cuda is not listed, never an error.
function findOrtDir(): string | undefined {
  try {
    const transformers = packageDir(TRANSFORMERS_PEER, import.meta.url);
    return packageDir(ORT, `${transformers}/package.json`);
  } catch {
    return undefined;
  }
}

/** Loads the profile, finds the host's onnxruntime-node and runs `detectSpeechRuntime` on the real platform. */
export async function resolveSpeechRuntime(opts: ResolveSpeechRuntimeOptions = {}): Promise<SpeechRuntime> {
  const env = opts.env ?? process.env;
  const profilePath = opts.profilePath ?? env[PROFILE_ENV];
  const profile = profilePath ? await loadTtsProfile(profilePath) : undefined;
  const ortDir = (opts.findOrtDir ?? findOrtDir)();
  return detectSpeechRuntime({
    platform: process.platform,
    arch: process.arch,
    env,
    home: homedir(),
    exists: existsSync,
    ...(ortDir === undefined ? {} : { ortDir }),
    ...(profile ? { profile } : {}),
    ...(opts.allowUnverifiedCuda === undefined ? {} : { allowUnverifiedCuda: opts.allowUnverifiedCuda }),
  });
}
