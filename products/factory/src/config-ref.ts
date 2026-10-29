import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parseConfig, type FactoryConfig } from "./config.js";

/** Which bytes the loaded config came from: `sha` is the file's sha256, null when no file was there. */
interface ConfigStamp {
  sha: string | null;
  loadedAt: string;
}

/**
 * The config file as serve holds it. `get()` and `stamp()` re-check the file and pick up an edit without a restart; live
 * readers go through `get()` per read, restart-class readers keep what they took at start.
 */
export interface ConfigRef {
  get(): FactoryConfig;
  stamp(): ConfigStamp;
  /** Re-reads the file; a file that fails to load throws and leaves the loaded config in force. */
  reload(): ConfigStamp;
}

/** `probe` is a cheap identity of the file's bytes (null when absent) so a read re-parses only after an edit. */
export interface ConfigFile {
  probe(path: string): string | null;
  read(path: string): Buffer;
}

export interface ConfigRefDeps {
  file?: ConfigFile;
  warn?: (line: string) => void;
}

/** The inode joins size and mtime because an editor's atomic save replaces the file without growing it. */
const diskConfigFile: ConfigFile = {
  probe(path) {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : null;
  },
  read: (path) => readFileSync(path),
};

interface Loaded {
  config: FactoryConfig;
  stamp: ConfigStamp;
  probe: string | null;
}

/** The sha and the parse come from one read of the file, so the stamp always names the bytes the config was parsed from. */
function loadStamped(path: string, now: () => number, file: ConfigFile): Loaded {
  const loadedAt = new Date(now()).toISOString();
  const probe = file.probe(path);
  if (probe === null) return { config: {}, stamp: { sha: null, loadedAt }, probe };
  const bytes = file.read(path);
  return { config: parseConfig(path, bytes.toString("utf8")), stamp: { sha: createHash("sha256").update(bytes).digest("hex"), loadedAt }, probe };
}

export function configRef(path: string, now: () => number = Date.now, deps: ConfigRefDeps = {}): ConfigRef {
  const file = deps.file ?? diskConfigFile;
  const warn = deps.warn ?? console.warn;
  let loaded = loadStamped(path, now, file);
  // The probe of an edit that failed to load, so a bad file warns once rather than on every read.
  let rejected: string | null | undefined;
  const refresh = () => {
    const probe = file.probe(path);
    if (probe === loaded.probe || probe === rejected) return;
    try {
      loaded = loadStamped(path, now, file);
      rejected = undefined;
    } catch (error) {
      rejected = probe;
      warn(`factory config: kept the loaded config, the edited file failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    get() {
      refresh();
      return loaded.config;
    },
    stamp() {
      refresh();
      return loaded.stamp;
    },
    reload() {
      loaded = loadStamped(path, now, file);
      rejected = undefined;
      return loaded.stamp;
    },
  };
}

/** A config value read through a getter on every use, or a value fixed by the caller. */
export type Live<T extends string | undefined> = T | (() => T);

export function current<T extends string | undefined>(value: Live<T>): T {
  return typeof value === "function" ? value() : value;
}

type Shepherd = NonNullable<FactoryConfig["shepherd"]>;

const READERS = {
  "shepherd.spawnGate.load5": (s: Shepherd) => s.spawnGate?.load5,
  "shepherd.spawnGate.buildLoad5": (s: Shepherd) => s.spawnGate?.buildLoad5,
  "shepherd.gateReset.noReproProceed": (s: Shepherd) => s.gateReset?.noReproProceed,
  "shepherd.gateReset.nonSourceNoRepro": (s: Shepherd) => s.gateReset?.nonSourceNoRepro,
  "shepherd.gateReset.heldRepair": (s: Shepherd) => s.gateReset?.heldRepair,
  "shepherd.gateReset.twoMergeRelease": (s: Shepherd) => s.gateReset?.twoMergeRelease,
  "shepherd.review.adversaryProfile": (s: Shepherd) => s.review?.adversaryProfile,
  "shepherd.review.fallbackConfigDirs": (s: Shepherd) => s.review?.fallbackConfigDirs,
  "shepherd.review.maxConcurrent": (s: Shepherd) => s.review?.maxConcurrent,
  "shepherd.taskClose": (s: Shepherd) => s.taskClose,
};

type LiveValues = { [P in keyof typeof READERS]: ReturnType<(typeof READERS)[P]> };

/**
 * One reader per `live` factory row of `EDITABLE_FIELDS`, keyed by the row's pattern. A consumer of a live row takes
 * `liveField(ref, pattern)`; a row with no reader here cannot be marked live, which the structure test enforces.
 */
export const LIVE_FIELDS: { readonly [P in keyof LiveValues]: (s: Shepherd) => LiveValues[P] } = READERS;

export function liveField<P extends keyof LiveValues>(ref: ConfigRef, path: P): () => LiveValues[P] {
  const read = LIVE_FIELDS[path];
  return () => read(ref.get().shepherd ?? {});
}
