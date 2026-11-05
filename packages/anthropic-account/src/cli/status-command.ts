import type { LoginState } from "../login.js";
import type { AccountUsage } from "../merge.js";
import type { AccountProfile } from "../profile.js";
import { redactSecrets } from "../redact.js";
import { readAccounts, type ReadAccountsOptions } from "../node/accounts.js";
import { readLoginState } from "../node/login.js";
import { readUsage, type UsageFileRead } from "../node/usage-file.js";
import { keychainOf, profilesOf, type CliContext } from "./context.js";
import {
  EXIT_FAILED,
  EXIT_LOGIN,
  EXIT_OK,
  exitFor,
  failureLine,
  loginLine,
  loginText,
  printableLabel,
  windowNames,
  windowsText,
} from "./report.js";
import { statuslineLines } from "./statusline.js";

export type StatusFormat = "text" | "json" | "statusline";

interface ProfileStatus {
  profile: AccountProfile;
  // null when the credentials file could not be read for an unexpected filesystem reason.
  login: LoginState | null;
  usage: UsageFileRead | null;
}

function orNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function statusOf(profile: AccountProfile, now: number, context: CliContext): ProfileStatus {
  const login = orNull(() => readLoginState(profile.configDir, { ...keychainOf(context), now, uid: context.uid }));
  return { profile, login, usage: orNull(() => readUsage(profile.configDir, { now })) };
}

function usageText(usage: UsageFileRead | null): string {
  if (usage === null) return "no reading";
  return `${windowsText(usage.reading.rate_limits)} (age ${usage.ageSeconds}s)`;
}

function textLine(status: ProfileStatus): string {
  const login = status.login === null ? "unreadable" : loginText(status.login);
  return `${printableLabel(status.profile.label)}: login ${login}; ${usageText(status.usage)}`;
}

const STATUS_SCHEMA = 2;

// Every string here may come from another writer's file or a directory name, so each is
// narrowed or redacted; the identity is two account ids, never a token.
function accountJson(row: AccountUsage): AccountUsage {
  const names = new Set(windowNames(row.windows));
  const windows = Object.fromEntries(Object.entries(row.windows).filter(([name]) => names.has(name)));
  const identity = row.identity === undefined ? {} : { identity: redactSecrets(row.identity) };
  const dirs = row.config_dirs.map((dir) => redactSecrets(dir));
  return { ...row, ...identity, account: printableLabel(row.account), config_dirs: dirs, windows };
}

function reportLogin(status: ProfileStatus, context: CliContext): number {
  const { label } = status.profile;
  if (status.login === null) {
    context.err(failureLine(label, "reading the credentials file failed"));
    return EXIT_FAILED;
  }
  if (status.login.status === "present") return EXIT_OK;
  context.err(loginLine(label, status.login));
  return EXIT_LOGIN;
}

function accountsOptions(context: CliContext, now: number): ReadAccountsOptions {
  return { ...keychainOf(context), env: context.env, now, uid: context.uid };
}

// The status line renders "unknown" itself, so that format never fails and writes no stderr.
export function runStatus(format: StatusFormat, context: CliContext): number {
  const now = context.now();
  const options = accountsOptions(context, now);
  if (format === "statusline") {
    const rows = orNull(() => readAccounts(options)) ?? [];
    statuslineLines(rows, options, context).forEach((line) => context.out(line));
    return EXIT_OK;
  }
  const profiles = profilesOf(context);
  const statuses = profiles.map((profile) => statusOf(profile, now, context));
  if (format === "json") context.out(JSON.stringify({ schema: STATUS_SCHEMA, accounts: readAccounts(options).map(accountJson) }));
  else statuses.forEach((status) => context.out(textLine(status)));
  return exitFor(statuses.map((status) => reportLogin(status, context)));
}
