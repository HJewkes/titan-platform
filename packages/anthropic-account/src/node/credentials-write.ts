import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RefusedReason } from "../login.js";
import { readGatedFile } from "./gated-read.js";
import { CREDENTIALS_FILE, MAX_CREDENTIALS_BYTES } from "./login.js";
import { syncDir } from "./usage-file.js";

// Claude Code 2.1.x serializes its own refresh with two proper-lockfile locks, each a
// directory made with mkdir: this one in the config dir and a legacy one beside it. Its
// stale time is 60 s, and with no holder record of its own it never takes over a fresher lock.
export const REFRESH_LOCK = ".oauth_refresh.lock";

export type CredentialsText =
  | { status: "text"; text: string }
  | { status: "missing" }
  | { status: "refused"; reason: RefusedReason };

export interface JsonFormat {
  indent: string | number | undefined;
  trailer: string;
}

const INDENTS: readonly (string | number | undefined)[] = [undefined, 2, 4, "\t"];

interface HeldDir {
  dir: string;
  ino: number;
}

// The exact text that passed the gate, so a later read can be compared byte for byte.
// Unexpected filesystem errors are thrown unredacted; the caller drops them.
export function readCredentialsText(configDir: string, uid: number): CredentialsText {
  const file = path.join(configDir, CREDENTIALS_FILE);
  const read = readGatedFile(file, { maxBytes: MAX_CREDENTIALS_BYTES, ownerUid: uid });
  if (read.status === "missing") return read;
  if (read.status === "refused") {
    return { status: "refused", reason: read.reason === "too-large" ? "malformed" : read.reason };
  }
  try {
    return { status: "text", text: read.bytes.toString("utf8") };
  } finally {
    read.bytes.fill(0);
  }
}

export function unchangedSince(configDir: string, uid: number, expected: string): boolean {
  const now = readCredentialsText(configDir, uid);
  return now.status === "text" && now.text === expected;
}

// Only a layout JSON.stringify reproduces exactly is rewritten, which is what keeps every
// field the refresh does not touch byte-identical.
export function jsonFormatOf(text: string, parsed: unknown): JsonFormat | null {
  const body = text.trimEnd();
  const index = INDENTS.findIndex((indent) => JSON.stringify(parsed, null, indent) === body);
  return index === -1 ? null : { indent: INDENTS[index], trailer: text.slice(body.length) };
}

function makeLockDir(dir: string): HeldDir | null {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  return { dir, ino: fs.lstatSync(dir).ino };
}

// A lock another process took over as stale is not this call's to remove.
function removeLockDir(held: HeldDir): void {
  try {
    if (fs.lstatSync(held.dir).ino === held.ino) fs.rmdirSync(held.dir);
  } catch {
    return;
  }
}

function legacyLockPath(configDir: string): string {
  try {
    return `${fs.realpathSync(configDir)}.lock`;
  } catch {
    return `${configDir}.lock`;
  }
}

// Takes both of Claude Code's refresh locks, in its order, or neither. A lock already held
// is never stolen, however old: Claude Code's own stale takeover handles a dead holder.
// Like Claude Code, an unusable legacy path (not a held one) is skipped.
export function acquireRefreshLock(configDir: string): (() => void) | null {
  const primary = makeLockDir(path.join(configDir, REFRESH_LOCK));
  if (primary === null) return null;
  let legacy: HeldDir | null | undefined;
  try {
    legacy = makeLockDir(legacyLockPath(configDir));
  } catch {
    legacy = undefined;
  }
  if (legacy === null) {
    removeLockDir(primary);
    return null;
  }
  return () => {
    if (legacy !== undefined) removeLockDir(legacy);
    removeLockDir(primary);
  };
}

function writeSynced(file: string, text: string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes `next` to a temp file in the same dir, then renames it over the credentials file
// only if the file still holds `expected`: a reader sees the old file or the new one, never
// a partial one, and a file another writer changed is left as that writer left it.
export function replaceCredentials(configDir: string, uid: number, expected: string, next: string): "written" | "changed" {
  const temp = path.join(configDir, `.${CREDENTIALS_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  try {
    writeSynced(temp, next);
    if (!unchangedSince(configDir, uid, expected)) return "changed";
    fs.renameSync(temp, path.join(configDir, CREDENTIALS_FILE));
    renamed = true;
  } finally {
    if (!renamed) fs.rmSync(temp, { force: true });
  }
  syncDir(configDir);
  return "written";
}
