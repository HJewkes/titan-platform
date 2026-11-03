import os from "node:os";
import { groupByIdentity, type IdentityGroup } from "../identity.js";
import type { LoginState } from "../login.js";
import { mergeAccountReadings, type AccountUsage } from "../merge.js";
import { DEFAULT_LABEL, type AccountProfile } from "../profile.js";
import { accountIdentity } from "./identity.js";
import type { KeychainOptions } from "./keychain.js";
import { readLoginState } from "./login.js";
import { discoverProfiles, type DiscoverOptions } from "./profiles.js";
import { readReadings } from "./usage-file.js";

export interface ReadAccountsOptions extends DiscoverOptions, KeychainOptions {
  now?: number;
  /** The login a config dir bills; defaults to accountIdentity. */
  identify?: (configDir: string) => string | undefined;
  /** The uid that must own each credentials file. Defaults to this process's. */
  uid?: number;
}

// On macOS Claude Code keeps the login in the Keychain, so a missing file is not a failure.
function loginFailed(state: LoginState, platform: NodeJS.Platform): boolean {
  if (state.status === "missing") return platform !== "darwin";
  return state.status === "refused" || (state.status === "expired" && !state.canRefresh);
}

function keychainOptions(options: ReadAccountsOptions): KeychainOptions {
  return { platform: options.platform, keychainExec: options.keychainExec, home: options.home };
}

function readLoginFailed(configDir: string, now: number, options: ReadAccountsOptions): boolean {
  try {
    const login = readLoginState(configDir, { ...keychainOptions(options), now, uid: options.uid });
    return loginFailed(login, options.platform ?? process.platform);
  } catch {
    return true;
  }
}

function readingsOf(configDir: string) {
  try {
    return readReadings(configDir);
  } catch {
    return [];
  }
}

// The default dir shares its login with a named profile on most setups (owner, 2026-11-02), and
// the named profile's label is the one the status line has a glyph for.
function accountName(members: readonly AccountProfile[]): string {
  return (members.find((member) => member.label !== DEFAULT_LABEL) ?? members[0])?.label ?? DEFAULT_LABEL;
}

/** One login's row: every member dir's readings merged, failing auth when any member's login fails. */
export function readAccountGroup(group: IdentityGroup<AccountProfile>, options: ReadAccountsOptions = {}): AccountUsage {
  const now = options.now ?? Date.now();
  const dirs = group.members.map((member) => member.configDir);
  return mergeAccountReadings(
    {
      account: accountName(group.members),
      config_dirs: dirs,
      ...(group.identity === undefined ? {} : { identity: group.identity }),
      auth_fail: dirs.some((dir) => readLoginFailed(dir, now, options)),
      readings: dirs.flatMap(readingsOf),
    },
    now,
  );
}

function safeIdentify(identify: (configDir: string) => string | undefined, configDir: string): string | undefined {
  try {
    return identify(configDir);
  } catch {
    return undefined;
  }
}

/** One row per Anthropic login, every discovered profile included, each naming all its config dirs. */
export function readAccounts(options: ReadAccountsOptions = {}): AccountUsage[] {
  const home = options.home ?? os.homedir();
  const identify = options.identify ?? ((configDir: string) => accountIdentity(configDir, home));
  const profiles = discoverProfiles({ home, env: options.env });
  const groups = groupByIdentity(profiles, (profile) => safeIdentify(identify, profile.configDir));
  const now = options.now ?? Date.now();
  return groups.map((group) => readAccountGroup(group, { ...options, now }));
}
