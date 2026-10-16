import { missingCapabilities } from "./capabilities.js";
import { loadTtsProfile, PROFILE_ENV, resolveTtsConfig, type ResolvedTtsConfig } from "./config.js";
import { TtsConfigError, TtsUnavailableError, TtsUnsupportedError, type SkippedProvider } from "./errors.js";
import { commandFactory, fakeFactory, httpFactory, type TtsProviderFactory } from "./factories.js";
import { errorMessage } from "./guards.js";
import type { TtsProvider, TtsRequirements } from "./types.js";

export type { SkippedProvider } from "./errors.js";

export interface TtsSelection {
  provider: TtsProvider;
  /** Providers tried before this one, and why each was passed over. Log it; it explains a fallback. */
  skipped: readonly SkippedProvider[];
}

export interface TtsRegistry {
  /** Adds a provider kind, such as the in-process Kokoro adapter, under the `kind` a profile names. */
  register(kind: string, factory: TtsProviderFactory): TtsRegistry;
  kinds(): string[];
  /** The first provider, in the config's order, that meets every requirement. */
  select(config: ResolvedTtsConfig, requirements?: TtsRequirements): TtsSelection;
}

const SELECTOR = "tts";

function tryProvider(
  factories: ReadonlyMap<string, TtsProviderFactory>,
  config: ResolvedTtsConfig,
  id: string,
  requirements: TtsRequirements,
): TtsProvider | SkippedProvider {
  const entry = config.providers[id];
  if (!entry) return { id, reason: "is not configured in the profile", misconfigured: true };
  if (config.unusable[id]) return { id, reason: `is misconfigured: ${config.unusable[id]}`, misconfigured: true };
  const factory = factories.get(entry.kind);
  if (!factory) return { id, reason: `has kind "${entry.kind}", which is not registered`, misconfigured: true };
  let provider: TtsProvider;
  try {
    provider = factory(id, entry);
  } catch (error) {
    return { id, reason: `is misconfigured: ${errorMessage(error)}`, misconfigured: true };
  }
  const missing = missingCapabilities(provider.capabilities, requirements);
  return missing.length > 0 ? { id, reason: `lacks ${missing.join(", ")}`, missing } : provider;
}

function noProvider(config: ResolvedTtsConfig, skipped: readonly SkippedProvider[]): Error {
  if (config.order.length === 0) {
    return new TtsUnavailableError(SELECTOR, `no provider configured; add tts.providers to the profile (${PROFILE_ENV}) or register one`);
  }
  const detail = skipped.map((s) => `${s.id} ${s.reason}`).join("; ");
  if (skipped.every((s) => s.missing)) {
    const missing = [...new Set(skipped.flatMap((s) => s.missing ?? []))];
    return new TtsUnsupportedError(SELECTOR, missing, `no provider meets the requirements: ${detail}`);
  }
  return new TtsUnavailableError(SELECTOR, `no usable provider: ${detail}`);
}

/** A misconfigured provider stops selection, so a fix to the profile is never silently papered over. */
function failClosed(broken: SkippedProvider, skipped: readonly SkippedProvider[]): TtsConfigError {
  const message = `${broken.id} ${broken.reason}. Fix the profile, or set tts.fallback: true to try the next provider`;
  return new TtsConfigError(SELECTOR, message, skipped);
}

function unknownKind(id: string, kind: string, registered: readonly string[], skipped: readonly SkippedProvider[]): TtsConfigError {
  const known = registered.length > 0 ? registered.join(", ") : "none";
  const message = `${id} has kind "${kind}", which is not registered (registered: ${known}). Fix the kind, or register a factory for it`;
  return new TtsConfigError(SELECTOR, message, skipped, "unknown-kind");
}

/** An empty registry. Use `defaultTtsRegistry` for the built-in kinds. */
export function createTtsRegistry(): TtsRegistry {
  const factories = new Map<string, TtsProviderFactory>();
  const registry: TtsRegistry = {
    register(kind, factory) {
      factories.set(kind, factory);
      return registry;
    },
    kinds: () => [...factories.keys()],
    select(config, requirements = {}) {
      const skipped: SkippedProvider[] = [];
      for (const id of config.order) {
        const result = tryProvider(factories, config, id, requirements);
        if ("synthesize" in result) return { provider: result, skipped };
        skipped.push(result);
        const kind = config.providers[id]?.kind;
        if (kind !== undefined && !factories.has(kind)) throw unknownKind(id, kind, [...factories.keys()], skipped);
        if (result.misconfigured && !config.fallback) throw failClosed(result, skipped);
      }
      throw noProvider(config, skipped);
    },
  };
  return registry;
}

/** The `command`, `http` and `fake` kinds. */
export function defaultTtsRegistry(): TtsRegistry {
  return createTtsRegistry().register("command", commandFactory).register("http", httpFactory).register("fake", fakeFactory);
}

export interface SelectTtsOptions {
  registry?: TtsRegistry;
  /** Falls back to `TITAN_SPEECH_PROFILE`. With neither, only env and registered kinds apply. */
  profilePath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  requirements?: TtsRequirements;
}

/** Loads the profile, applies env overrides and selects: the one call a product needs. */
export async function selectTts(opts: SelectTtsOptions = {}): Promise<TtsSelection> {
  const env = opts.env ?? process.env;
  const path = opts.profilePath ?? env[PROFILE_ENV];
  const profile = path ? await loadTtsProfile(path) : undefined;
  const config = resolveTtsConfig({ env, ...(profile ? { profile } : {}) });
  return (opts.registry ?? defaultTtsRegistry()).select(config, opts.requirements);
}
