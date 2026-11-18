import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";
// errSecItemNotFound: `security` exits 44 when no item carries the service name.
const ITEM_NOT_FOUND = 44;
const SECURITY_TIMEOUT_MS = 10_000;
const KEYCHAIN_FAILED = "reading the Keychain item failed";

// stdout holds the credentials JSON. The caller never reads stderr, so whatever it says
// cannot travel further.
export interface KeychainExecResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export type KeychainExec = (file: string, args: readonly string[]) => KeychainExecResult;

export interface KeychainOptions {
  // Default process.platform. Only darwin reads the Keychain; every other platform reads
  // `<configDir>/.credentials.json`.
  platform?: NodeJS.Platform;
  // Runs `security`. Tests pass a stub, so the real Keychain is never read.
  keychainExec?: KeychainExec;
  // Default os.homedir(). Its `.claude` is the dir with the bare service name.
  home?: string;
}

type KeychainRead = { status: "missing" } | { status: "too-large" } | { status: "read"; bytes: Buffer };

// rate-limits.sh resolves both dirs with `pwd -P`, so symlinks are followed here too. A dir
// that does not exist cannot be resolved and is hashed as its absolute path.
function canonical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// Claude Code's naming, as the darwin rate-limits.sh reads it: the default `~/.claude` uses
// the bare name and every other config dir appends the first eight hex of the SHA-256 of
// its symlink-resolved absolute path.
export function keychainService(configDir: string, home: string): string {
  const dir = canonical(configDir);
  if (dir === canonical(path.join(home, ".claude"))) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}

// stderr is never piped, so the child's message never enters this process.
function runSecurity(file: string, args: readonly string[], maxBytes: number): KeychainExecResult {
  const result = spawnSync(file, args, {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: maxBytes + 1,
    timeout: SECURITY_TIMEOUT_MS,
  });
  // stdout is typed as a Buffer but is null when the spawn itself fails.
  if (result.error !== undefined) {
    if (Buffer.isBuffer(result.stdout)) result.stdout.fill(0);
    throw new Error(KEYCHAIN_FAILED);
  }
  return { status: result.status, stdout: result.stdout, stderr: Buffer.alloc(0) };
}

function execFor(options: KeychainOptions, maxBytes: number): KeychainExec {
  return options.keychainExec ?? ((file, args) => runSecurity(file, args, maxBytes));
}

// Read-only: `find-generic-password -w` prints the item and never writes it. A run that
// fails for any reason but a missing item throws a fixed message with no cause.
export function readKeychainItem(configDir: string, maxBytes: number, options: KeychainOptions): KeychainRead {
  const service = keychainService(configDir, options.home ?? os.homedir());
  let result: KeychainExecResult;
  try {
    result = execFor(options, maxBytes)(SECURITY_BIN, ["find-generic-password", "-s", service, "-w"]);
  } catch {
    throw new Error(KEYCHAIN_FAILED);
  }
  if (result.status === 0 && result.stdout.length <= maxBytes) return { status: "read", bytes: result.stdout };
  result.stdout.fill(0);
  if (result.status === ITEM_NOT_FOUND) return { status: "missing" };
  if (result.status === 0) return { status: "too-large" };
  throw new Error(KEYCHAIN_FAILED);
}
