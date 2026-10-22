import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseConfig, type FactoryConfig } from "./config.js";

/** Which bytes the loaded config came from: `sha` is the file's sha256, null when no file was there. */
interface ConfigStamp {
  sha: string | null;
  loadedAt: string;
}

/** The config file as serve holds it. Live readers go through `get()` per read; restart-class readers keep what they took at start. */
export interface ConfigRef {
  get(): FactoryConfig;
  stamp(): ConfigStamp;
  /** Re-reads the file; a file that fails to load throws and leaves the loaded config in force. */
  reload(): ConfigStamp;
}

interface Loaded {
  config: FactoryConfig;
  stamp: ConfigStamp;
}

/** The sha and the parse come from one read of the file, so the stamp always names the bytes the config was parsed from. */
function loadStamped(path: string, now: () => number): Loaded {
  const loadedAt = new Date(now()).toISOString();
  if (!existsSync(path)) return { config: {}, stamp: { sha: null, loadedAt } };
  const bytes = readFileSync(path);
  return { config: parseConfig(path, bytes.toString("utf8")), stamp: { sha: createHash("sha256").update(bytes).digest("hex"), loadedAt } };
}

export function configRef(path: string, now: () => number = Date.now): ConfigRef {
  let loaded = loadStamped(path, now);
  return {
    get: () => loaded.config,
    stamp: () => loaded.stamp,
    reload() {
      loaded = loadStamped(path, now);
      return loaded.stamp;
    },
  };
}

/** A config value read through a getter on every use, or a value fixed by the caller. */
export type Live<T> = T | (() => T);

export function current<T>(value: Live<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

type Shepherd = NonNullable<FactoryConfig["shepherd"]>;

/**
 * One reader per `live` factory row of `EDITABLE_FIELDS`, keyed by the row's pattern. A consumer of a live row takes
 * `liveField(ref, pattern)`; a row with no reader here cannot be marked live, which the structure test enforces.
 */
export const LIVE_FIELDS = {
  "shepherd.spawnGate.load5": (s: Shepherd) => s.spawnGate?.load5,
  "shepherd.spawnGate.buildLoad5": (s: Shepherd) => s.spawnGate?.buildLoad5,
  "shepherd.gateReset.noReproProceed": (s: Shepherd) => s.gateReset?.noReproProceed,
  "shepherd.gateReset.heldRepair": (s: Shepherd) => s.gateReset?.heldRepair,
  "shepherd.gateReset.twoMergeRelease": (s: Shepherd) => s.gateReset?.twoMergeRelease,
  "shepherd.review.adversaryProfile": (s: Shepherd) => s.review?.adversaryProfile,
  "shepherd.review.fallbackConfigDirs": (s: Shepherd) => s.review?.fallbackConfigDirs,
  "shepherd.review.maxConcurrent": (s: Shepherd) => s.review?.maxConcurrent,
} as const;

type LiveFieldPath = keyof typeof LIVE_FIELDS;

export function liveField<P extends LiveFieldPath>(ref: ConfigRef, path: P): () => ReturnType<(typeof LIVE_FIELDS)[P]> {
  const read = LIVE_FIELDS[path] as (s: Shepherd) => ReturnType<(typeof LIVE_FIELDS)[P]>;
  return () => read(ref.get().shepherd ?? {});
}
