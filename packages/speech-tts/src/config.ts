import { readFile } from "node:fs/promises";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { isStringArray } from "./guards.js";

/** One provider entry. `kind` picks the registry factory; the factory validates the rest. */
export type TtsProviderConfig = { kind: string } & Readonly<Record<string, unknown>>;

/** The speech models a runtime places on a device. */
export type SpeechComponent = "tts" | "stt" | "phones";

const SPEECH_COMPONENTS: readonly SpeechComponent[] = ["tts", "stt", "phones"];

/** The profile's `runtime` section. Device names are checked by `detectSpeechRuntime`, not here. */
export interface SpeechRuntimeProfile {
  device?: Readonly<Partial<Record<SpeechComponent, string>>>;
  cacheDir?: string;
}

/** The `profile.json` document, version 1. The `tts` and `runtime` sections are read here. */
export interface TtsProfile {
  version: 1;
  tts?: {
    /** Provider ids to try first, in order. Providers not named follow in declaration order. */
    prefer?: readonly string[];
    providers?: Readonly<Record<string, TtsProviderConfig>>;
    /** Lets selection move past a misconfigured provider. Off by default: a broken preferred engine fails closed. */
    fallback?: boolean;
  };
  runtime?: SpeechRuntimeProfile;
}

export interface ResolvedTtsConfig {
  /** Every provider id, in the order selection tries them. */
  order: readonly string[];
  providers: Readonly<Record<string, TtsProviderConfig>>;
  /** Providers that cannot be used as configured, with the reason, such as a secret that resolves to nothing. */
  unusable: Readonly<Record<string, string>>;
  fallback: boolean;
}

export type SpeechEnv = Readonly<Record<string, string | undefined>>;
type Env = SpeechEnv;

export const PROFILE_ENV = "TITAN_SPEECH_PROFILE";
export const PREFER_ENV = "TITAN_SPEECH_TTS";

/** `TITAN_SPEECH_TTS_<ID>_<FIELD>`, with the id upper-cased and every other character as `_`. */
export const providerEnvName = (id: string, field: string): string =>
  `${PREFER_ENV}_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${field}`;

const isProviderConfig = (v: unknown): v is TtsProviderConfig => isRecord(v) && typeof v.kind === "string";

type Fail = (why: string) => never;

/** Validates the document's shape; each provider's own fields are left to its factory. */
export function parseTtsProfile(raw: unknown, source = "profile"): TtsProfile {
  const fail = (why: string): never => {
    throw new TypeError(`${source}: ${why}`);
  };
  if (!isRecord(raw) || raw.version !== 1) return fail('expected { "version": 1, ... }');
  return {
    version: 1,
    ...(raw.tts !== undefined ? { tts: parseTtsSection(raw.tts, fail) } : {}),
    ...(raw.runtime !== undefined ? { runtime: parseRuntimeSection(raw.runtime, fail) } : {}),
  };
}

function parseRuntimeDevice(device: unknown, fail: Fail): SpeechRuntimeProfile["device"] {
  if (!isRecord(device)) return fail("runtime.device must be an object keyed by tts, stt or phones");
  const parsed: Partial<Record<SpeechComponent, string>> = {};
  for (const [key, value] of Object.entries(device)) {
    const component = SPEECH_COMPONENTS.find((c) => c === key) ?? fail(`runtime.device.${key} is not tts, stt or phones`);
    parsed[component] = typeof value === "string" ? value : fail(`runtime.device.${key} must be a device name string`);
  }
  return parsed;
}

function parseRuntimeSection(runtime: unknown, fail: Fail): SpeechRuntimeProfile {
  if (!isRecord(runtime)) return fail("runtime must be an object");
  if (runtime.cacheDir !== undefined && typeof runtime.cacheDir !== "string") fail("runtime.cacheDir must be a string");
  return {
    ...(runtime.device !== undefined ? { device: parseRuntimeDevice(runtime.device, fail) } : {}),
    ...(typeof runtime.cacheDir === "string" ? { cacheDir: runtime.cacheDir } : {}),
  };
}

function parseTtsSection(tts: unknown, fail: Fail): NonNullable<TtsProfile["tts"]> {
  if (!isRecord(tts)) return fail("tts must be an object");
  const prefer = tts.prefer ?? [];
  if (!isStringArray(prefer)) return fail("tts.prefer must be an array of provider ids");
  const declared = tts.providers ?? {};
  if (!isRecord(declared)) return fail("tts.providers must be an object keyed by provider id");
  if (tts.fallback !== undefined && typeof tts.fallback !== "boolean") return fail("tts.fallback must be true or false");
  const providers: Record<string, TtsProviderConfig> = {};
  for (const [id, entry] of Object.entries(declared)) {
    providers[id] = isProviderConfig(entry) ? entry : fail(`tts.providers.${id} needs a string "kind"`);
  }
  return { prefer, providers, ...(tts.fallback !== undefined ? { fallback: tts.fallback } : {}) };
}

/** Reads a profile file. A missing file is no profile, not an error: nothing about the host is assumed. */
export async function loadTtsProfile(path: string): Promise<TtsProfile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return parseTtsProfile(JSON.parse(text), path);
}

function parseArgvEnv(name: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${name} must be a JSON array of strings, such as ["ssh", "gpu-box", "tts-cli"]`);
  }
}

function envOverrides(id: string, entry: TtsProviderConfig, env: Env): TtsProviderConfig {
  const url = env[providerEnvName(id, "URL")];
  const argv = env[providerEnvName(id, "ARGV")];
  const timeout = env[providerEnvName(id, "TIMEOUT_MS")];
  return {
    ...entry,
    ...(url ? { url } : {}),
    ...(argv ? { argv: parseArgvEnv(providerEnvName(id, "ARGV"), argv) } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
  };
}

const SECRET = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface Expanded {
  values: Record<string, string>;
  secrets: string[];
  problems: string[];
}

/** Expands `${env:NAME}` in one map's values. An unset or empty NAME is a problem, never an empty value. */
function expandMap(field: string, map: Record<string, unknown>, env: Env): Expanded {
  const out: Expanded = { values: {}, secrets: [], problems: [] };
  for (const [name, value] of Object.entries(map)) {
    out.values[name] = String(value).replace(SECRET, (_, key: string) => {
      const resolved = env[key];
      if (!resolved) out.problems.push(`${field}.${name} needs env ${key}, which is unset or empty`);
      else out.secrets.push(resolved);
      return resolved ?? "";
    });
  }
  return out;
}

/**
 * Expands secrets in `headers` (http) and `env` (command), so a profile can be shared without them. The expanded
 * values ride along as `secrets`, which adapters redact from error text.
 */
function expandSecrets(entry: TtsProviderConfig, env: Env): { entry: TtsProviderConfig; problems: string[] } {
  const fields = (["headers", "env"] as const).filter((f) => isRecord(entry[f]));
  const expanded = fields.map((f) => [f, expandMap(f, isRecord(entry[f]) ? entry[f] : {}, env)] as const);
  if (expanded.length === 0) return { entry, problems: [] };
  return {
    entry: {
      ...entry,
      ...Object.fromEntries(expanded.map(([f, e]) => [f, e.values])),
      // A profile's own literal secrets stay; the expanded values are added to them.
      secrets: [...(isStringArray(entry.secrets) ? entry.secrets : []), ...expanded.flatMap(([, e]) => e.secrets)],
    },
    problems: expanded.flatMap(([, e]) => e.problems),
  };
}

/**
 * `TITAN_SPEECH_TTS` is an explicit choice, so it is the whole order and nothing else is tried. The profile's
 * `prefer` only moves providers to the front.
 */
function selectionOrder(ids: readonly string[], profilePrefer: readonly string[], envChoice: readonly string[] | undefined): string[] {
  if (envChoice) return [...new Set(envChoice)];
  return [...new Set([...profilePrefer.filter((id) => ids.includes(id)), ...ids])];
}

/** Applies env over the profile: env wins. Neither is required; with neither, there are no providers. */
export function resolveTtsConfig(opts: { profile?: TtsProfile; env?: Env } = {}): ResolvedTtsConfig {
  const env = opts.env ?? process.env;
  const declared = opts.profile?.tts?.providers ?? {};
  const providers: Record<string, TtsProviderConfig> = {};
  const unusable: Record<string, string> = {};
  for (const [id, raw] of Object.entries(declared)) {
    const { entry, problems } = expandSecrets(envOverrides(id, raw, env), env);
    providers[id] = entry;
    if (problems.length > 0) unusable[id] = problems.join("; ");
  }
  const envChoice = env[PREFER_ENV]?.split(",").map((s) => s.trim()).filter(Boolean);
  const order = selectionOrder(Object.keys(providers), opts.profile?.tts?.prefer ?? [], envChoice?.length ? envChoice : undefined);
  return { order, providers, unusable, fallback: opts.profile?.tts?.fallback === true };
}
