import type { LoginState } from "../login.js";
import { redactSecrets } from "../redact.js";
import type { UsageWindow } from "../usage.js";

export const PROGRAM = "anthropic-account";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_LOGIN = 2;
export const EXIT_USAGE = 64;

const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;
const WINDOW_NAME = /^[a-z0-9_]{1,40}$/;

// A profile label comes from a directory name, so one that is not a short plain name, or
// that looks like a token, is never printed.
export function printableLabel(label: string): string {
  return LABEL.test(label) && redactSecrets(label) === label ? label : "unlabelled";
}

export function loginText(login: LoginState): string {
  return login.status === "refused" ? `refused (${login.reason})` : login.status;
}

// One fixed line per account whose login is not present; nothing from the file is quoted.
export function loginLine(label: string, login: LoginState): string {
  return `${PROGRAM}: ${printableLabel(label)}: login ${loginText(login)}`;
}

export function failureLine(label: string, what: string): string {
  return `${PROGRAM}: ${printableLabel(label)}: ${what}`;
}

function percent(window: UsageWindow): string {
  return `${Math.round(window.used_percentage * 10) / 10}%`;
}

// Another writer's reading file may carry any key, so only a short snake-case name that
// redaction leaves alone is printed.
export function windowNames(rateLimits: Readonly<Record<string, UsageWindow>>): string[] {
  return Object.keys(rateLimits)
    .filter((name) => WINDOW_NAME.test(name) && redactSecrets(name) === name)
    .sort();
}

export function windowsText(rateLimits: Readonly<Record<string, UsageWindow>>): string {
  const names = windowNames(rateLimits);
  return names.map((name) => `${name} ${percent(rateLimits[name] as UsageWindow)}`).join(", ");
}

export function exitFor(codes: readonly number[]): number {
  if (codes.includes(EXIT_LOGIN)) return EXIT_LOGIN;
  return codes.includes(EXIT_FAILED) ? EXIT_FAILED : EXIT_OK;
}
