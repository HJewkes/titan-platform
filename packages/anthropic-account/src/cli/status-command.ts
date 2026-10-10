import type { LoginState } from "../login.js";
import type { AccountProfile } from "../profile.js";
import { redactSecrets } from "../redact.js";
import { readLoginState } from "../node/login.js";
import { readUsage, type UsageFileRead } from "../node/usage-file.js";
import { profilesOf, type CliContext } from "./context.js";
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

function statusOf(profile: AccountProfile, now: number, uid: number | undefined): ProfileStatus {
  const login = orNull(() => readLoginState(profile.configDir, { now, uid }));
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

function usageJson(usage: UsageFileRead | null): unknown {
  if (usage === null) return null;
  const rateLimits = usage.reading.rate_limits;
  const windows = Object.fromEntries(windowNames(rateLimits).map((name) => [name, rateLimits[name]]));
  return { written_at: usage.reading.written_at, age_seconds: usage.ageSeconds, rate_limits: windows };
}

// LoginState has no token field, so it is printed whole.
function jsonOf(status: ProfileStatus): unknown {
  return {
    label: printableLabel(status.profile.label),
    configDir: redactSecrets(status.profile.configDir),
    login: status.login ?? { status: "unreadable" },
    usage: usageJson(status.usage),
  };
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

// The status line renders "unknown" itself, so that format never fails and writes no stderr.
export function runStatus(format: StatusFormat, context: CliContext): number {
  const now = context.now();
  if (format === "statusline") {
    const others = orNull(() => profilesOf(context)) ?? [];
    statuslineLines(others, now, context).forEach((line) => context.out(line));
    return EXIT_OK;
  }
  const profiles = profilesOf(context);
  const statuses = profiles.map((profile) => statusOf(profile, now, context.uid));
  if (format === "json") context.out(JSON.stringify({ profiles: statuses.map(jsonOf) }));
  else statuses.forEach((status) => context.out(textLine(status)));
  return exitFor(statuses.map((status) => reportLogin(status, context)));
}
