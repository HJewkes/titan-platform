import type { AccountProfile } from "../profile.js";
import type { KeychainExec, KeychainOptions } from "../node/keychain.js";
import type { FetchLike } from "../node/poll.js";
import { discoverProfiles } from "../node/profiles.js";

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  // Defaults to os.homedir(); tests pass a temp dir.
  home?: string;
  // Defaults to globalThis.fetch. It receives the raw tokens, so tests pass a fake.
  fetch?: FetchLike;
  now: () => number;
  // The uid that must own each credentials file. Defaults to this process's.
  uid?: number;
  // Default process.platform. On darwin logins are read from the Keychain and never refreshed.
  platform?: NodeJS.Platform;
  // Runs `security` on darwin. Tests pass a stub, so the real Keychain is never read.
  keychainExec?: KeychainExec;
  // Runs systemctl or launchctl; rejects on a non-zero exit. Tests pass a recorder.
  exec?: (file: string, args: readonly string[]) => Promise<void>;
  // Directory holding the shipped systemd units. Defaults to the package's own.
  templateDir?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function profilesOf(context: CliContext): AccountProfile[] {
  return discoverProfiles({ home: context.home, env: context.env });
}

export function fetchOf(context: CliContext): FetchLike {
  return context.fetch ?? globalThis.fetch;
}

export function keychainOf(context: CliContext): KeychainOptions {
  return { platform: context.platform, keychainExec: context.keychainExec, home: context.home };
}
