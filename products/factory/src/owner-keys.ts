import type { KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStat, GROUP_OR_OTHER_WRITE, pathComponents, S_IFLNK, S_IFMT, S_IFREG, type StatPort } from "./owner-presence.js";
import { keyRing, type KeyRing } from "./presence-proof.js";

/**
 * Only root can write here, so no agent running as the factory's user can install its own key. Fixed in code like
 * `ROOT_HELPER_PATH`: no environment variable, flag or config can point the loader elsewhere.
 */
export const OWNER_KEYS_DIR = "/etc/titan-factory/owner-keys";

const S_IFDIR = 0o040000;

export type OwnerKeys = { ok: true; ring: KeyRing; ids: string[] } | { ok: false; refusal: string };

/** Tests swap the directory and stat; serve uses the defaults. */
export interface KeyDirPorts {
  dir: string;
  stat: StatPort;
  list: (dir: string) => string[];
  read: (path: string) => string;
}

const DEFAULT_PORTS: KeyDirPorts = { dir: OWNER_KEYS_DIR, stat: defaultStat, list: (dir) => readdirSync(dir), read: (path) => readFileSync(path, "utf8") };

/** Why `path` is not something only root can replace: missing, a symlink, owned by another uid, or group or other writable. */
function rootOnlyRefusal(path: string, stat: StatPort): string | undefined {
  const info = stat(path);
  if (info === undefined) return `${path} is missing`;
  if ((info.mode & S_IFMT) === S_IFLNK) return `${path} is a symlink`;
  if (info.uid !== 0) return `${path} is owned by uid ${info.uid}, not root`;
  if ((info.mode & GROUP_OR_OTHER_WRITE) !== 0) return `${path} is group or other writable`;
  return undefined;
}

/** The directory and every parent up to / must pass, so no component on the way can be swapped for a user-owned one. */
function dirRefusal(dir: string, stat: StatPort): string | undefined {
  for (const component of pathComponents(dir)) {
    const refusal = rootOnlyRefusal(component, stat);
    if (refusal !== undefined) return refusal;
  }
  return (stat(dir)!.mode & S_IFMT) === S_IFDIR ? undefined : `${dir} is not a directory`;
}

function fileRefusal(path: string, stat: StatPort): string | undefined {
  const refusal = rootOnlyRefusal(path, stat);
  if (refusal !== undefined) return refusal;
  return (stat(path)!.mode & S_IFMT) === S_IFREG ? undefined : `${path} is not a regular file`;
}

/**
 * Loads every `*.pem` owner public key from the root-owned key directory. Fails closed: one component or key file that
 * fails the check, or one key that is not ECDSA P-256, refuses the whole set, since either means someone tampered with it.
 * The directory itself is root-only, so no file can be swapped between its check and its read.
 */
export function loadOwnerKeys(overrides: Partial<KeyDirPorts> = {}): OwnerKeys {
  const ports = { ...DEFAULT_PORTS, ...overrides };
  try {
    return loadChecked(ports);
  } catch (error) {
    return { ok: false, refusal: `reading ${ports.dir} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function loadChecked({ dir, stat, list, read }: KeyDirPorts): OwnerKeys {
  const refusal = dirRefusal(dir, stat);
  if (refusal !== undefined) return { ok: false, refusal };
  const files = list(dir).filter((name) => name.endsWith(".pem")).sort().map((name) => join(dir, name));
  if (files.length === 0) return { ok: false, refusal: `no .pem key in ${dir}` };
  for (const file of files) {
    const refused = fileRefusal(file, stat);
    if (refused !== undefined) return { ok: false, refusal: refused };
  }
  const ring = new Map<string, KeyObject>();
  for (const file of files) {
    try {
      for (const [id, key] of keyRing([read(file)])) ring.set(id, key);
    } catch (error) {
      return { ok: false, refusal: `${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, ring, ids: [...ring.keys()] };
}
