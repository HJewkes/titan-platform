import fs from "node:fs";
import path from "node:path";
import { loginStateFromCredentials, type LoginState, type RefusedReason } from "../login.js";
import { redactedError } from "./redact-error.js";

export const CREDENTIALS_FILE = ".credentials.json";
export const MAX_CREDENTIALS_BYTES = 64 * 1024;

// O_NOFOLLOW makes a symlink swapped in after the lstat fail the open, and O_NONBLOCK keeps
// a FIFO swapped in from hanging it; the fstat then refuses either.
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

export interface ReadLoginOptions {
  now?: number;
  // The uid that must own the file. Defaults to this process's; tests pass another.
  uid?: number;
}

const refused = (reason: RefusedReason): LoginState => ({ status: "refused", reason });

// Where the platform has no uid, no owner can match, so every file is refused.
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function openGated(file: string): number | RefusedReason | null {
  try {
    return fs.openSync(file, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") return "not-a-regular-file";
    throw error;
  }
}

// Runs on the open descriptor, so what is checked is exactly what would be read.
function gateReason(open: fs.Stats, seen: fs.Stats, uid: number): RefusedReason | null {
  if (!open.isFile() || open.dev !== seen.dev || open.ino !== seen.ino) return "not-a-regular-file";
  if (open.uid !== uid) return "foreign-owner";
  if ((open.mode & 0o077) !== 0) return "mode-too-wide";
  if (open.size > MAX_CREDENTIALS_BYTES) return "malformed";
  return null;
}

function readBounded(fd: number): Buffer | null {
  const buffer = Buffer.alloc(MAX_CREDENTIALS_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (n === 0) break;
    length += n;
  }
  if (length > MAX_CREDENTIALS_BYTES) {
    buffer.fill(0);
    return null;
  }
  return buffer.subarray(0, length);
}

// JSON.parse's SyntaxError quotes the input, so its message is dropped, never wrapped.
function stateFromBytes(bytes: Buffer, now: number): LoginState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refused("malformed");
  } finally {
    bytes.fill(0);
  }
  return loginStateFromCredentials(parsed, now);
}

function readFromFd(fd: number, seen: fs.Stats, uid: number, now: number): LoginState {
  const reason = gateReason(fs.fstatSync(fd), seen, uid);
  if (reason !== null) return refused(reason);
  const bytes = readBounded(fd);
  return bytes === null ? refused("malformed") : stateFromBytes(bytes, now);
}

function readGated(file: string, uid: number, now: number): LoginState {
  const seen = lstatOrNull(file);
  if (seen === null) return { status: "missing" };
  if (!seen.isFile()) return refused("not-a-regular-file");
  const fd = openGated(file);
  if (fd === null) return { status: "missing" };
  if (typeof fd === "string") return refused(fd);
  try {
    return readFromFd(fd, seen, uid, now);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads `<configDir>/.credentials.json` read-only. A symlink, a non-regular file, a mode
// wider than 0600 or another owner is refused before a byte is read. No token is returned,
// and a thrown error is redacted and carries no cause.
export function readLoginState(configDir: string, options: ReadLoginOptions = {}): LoginState {
  try {
    const file = path.join(configDir, CREDENTIALS_FILE);
    return readGated(file, options.uid ?? currentUid(), options.now ?? Date.now());
  } catch (error) {
    throw redactedError(error, "reading the credentials file failed");
  }
}
