import path from "node:path";
import { loginStateFromCredentials, type LoginState, type RefusedReason } from "../login.js";
import { readGatedFile } from "./gated-read.js";
import { readKeychainItem, type KeychainOptions } from "./keychain.js";
import { redactedError } from "./redact-error.js";

export const CREDENTIALS_FILE = ".credentials.json";
export const MAX_CREDENTIALS_BYTES = 64 * 1024;

export interface ReadLoginOptions extends KeychainOptions {
  now?: number;
  // The uid that must own the file. Defaults to this process's; tests pass another.
  uid?: number;
}

// The parsed object holds the tokens, so it stays inside this subpath and is never exported.
export type CredentialsRead =
  | { status: "parsed"; credentials: unknown }
  | { status: "missing" }
  | { status: "refused"; reason: RefusedReason };

// Where the platform has no uid, no owner can match, so every file is refused.
export function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

// JSON.parse's SyntaxError quotes the input, so its message is dropped, never wrapped.
function parseBytes(bytes: Buffer): CredentialsRead {
  try {
    return { status: "parsed", credentials: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { status: "refused", reason: "malformed" };
  } finally {
    bytes.fill(0);
  }
}

// Unexpected filesystem errors are thrown unredacted; the caller redacts.
export function readCredentialsFile(configDir: string, uid: number): CredentialsRead {
  const file = path.join(configDir, CREDENTIALS_FILE);
  const read = readGatedFile(file, { maxBytes: MAX_CREDENTIALS_BYTES, ownerUid: uid });
  if (read.status === "missing") return read;
  if (read.status === "read") return parseBytes(read.bytes);
  return { status: "refused", reason: read.reason === "too-large" ? "malformed" : read.reason };
}

// On darwin Claude Code keeps the login in the Keychain, so the file is not read there.
export function readCredentialsFor(configDir: string, uid: number, options: KeychainOptions): CredentialsRead {
  if ((options.platform ?? process.platform) !== "darwin") return readCredentialsFile(configDir, uid);
  const read = readKeychainItem(configDir, MAX_CREDENTIALS_BYTES, options);
  if (read.status === "read") return parseBytes(read.bytes);
  return read.status === "missing" ? read : { status: "refused", reason: "malformed" };
}

function readCredentials(configDir: string, now: number, options: ReadLoginOptions): LoginState {
  const read = readCredentialsFor(configDir, options.uid ?? currentUid(), options);
  return read.status === "parsed" ? loginStateFromCredentials(read.credentials, now) : read;
}

// Reads `<configDir>/.credentials.json` read-only, or on darwin the config dir's Keychain
// item. A symlink, a non-regular file, a mode wider than 0600, another owner or a second
// hard link is refused before a byte is read. No token is returned, and a thrown error is
// redacted and carries no cause.
export function readLoginState(configDir: string, options: ReadLoginOptions = {}): LoginState {
  try {
    return readCredentials(configDir, options.now ?? Date.now(), options);
  } catch (error) {
    throw redactedError(error, "reading the credentials file failed");
  }
}
