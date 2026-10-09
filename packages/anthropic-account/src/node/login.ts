import path from "node:path";
import { loginStateFromCredentials, type LoginState } from "../login.js";
import { readGatedFile } from "./gated-read.js";
import { redactedError } from "./redact-error.js";

export const CREDENTIALS_FILE = ".credentials.json";
export const MAX_CREDENTIALS_BYTES = 64 * 1024;

export interface ReadLoginOptions {
  now?: number;
  // The uid that must own the file. Defaults to this process's; tests pass another.
  uid?: number;
}

// Where the platform has no uid, no owner can match, so every file is refused.
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

// JSON.parse's SyntaxError quotes the input, so its message is dropped, never wrapped.
function stateFromBytes(bytes: Buffer, now: number): LoginState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { status: "refused", reason: "malformed" };
  } finally {
    bytes.fill(0);
  }
  return loginStateFromCredentials(parsed, now);
}

function readCredentials(file: string, uid: number, now: number): LoginState {
  const read = readGatedFile(file, { maxBytes: MAX_CREDENTIALS_BYTES, ownerUid: uid });
  if (read.status === "missing") return read;
  if (read.status === "read") return stateFromBytes(read.bytes, now);
  return { status: "refused", reason: read.reason === "too-large" ? "malformed" : read.reason };
}

// Reads `<configDir>/.credentials.json` read-only. A symlink, a non-regular file, a mode
// wider than 0600, another owner or a second hard link is refused before a byte is read.
// No token is returned, and a thrown error is redacted and carries no cause.
export function readLoginState(configDir: string, options: ReadLoginOptions = {}): LoginState {
  try {
    const file = path.join(configDir, CREDENTIALS_FILE);
    return readCredentials(file, options.uid ?? currentUid(), options.now ?? Date.now());
  } catch (error) {
    throw redactedError(error, "reading the credentials file failed");
  }
}
