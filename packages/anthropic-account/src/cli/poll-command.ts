import type { AccountProfile } from "../profile.js";
import { pollAll, pollUsage, type PollAllEntry, type PollFailure, type PollOptions } from "../node/poll.js";
import { refreshIfNeeded, type RefreshResult } from "../node/refresh.js";
import { fetchOf, keychainOf, profilesOf, type CliContext } from "./context.js";
import { EXIT_FAILED, EXIT_LOGIN, EXIT_OK, exitFor, failureLine, printableLabel, windowsText } from "./report.js";

// The timer runs every 150 s, so a token due within 10 minutes gets several tries before
// it lapses.
const REFRESH_MARGIN_MS = 10 * 60_000;

interface PollFlags {
  write: boolean;
  refresh: boolean;
}

function reportRefresh(profile: AccountProfile, result: RefreshResult, context: CliContext): number {
  if (result.status === "refreshed") context.out(`${printableLabel(profile.label)}: token refreshed`);
  if (result.status !== "failed") return EXIT_OK;
  context.err(failureLine(profile.label, `token refresh failed: ${result.failure}`));
  return EXIT_FAILED;
}

async function refreshAll(profiles: readonly AccountProfile[], now: number, context: CliContext): Promise<number[]> {
  const options = { fetch: fetchOf(context), marginMs: REFRESH_MARGIN_MS, now, uid: context.uid };
  const results = await Promise.all(
    profiles.map(async (profile) => ({ profile, result: await refreshIfNeeded(profile, options) })),
  );
  return results.map(({ profile, result }) => reportRefresh(profile, result, context));
}

function failureText(failure: PollFailure): string {
  if (failure.failure === "refused") return `login refused (${failure.reason})`;
  if (failure.failure === "missing" || failure.failure === "expired") return `login ${failure.failure}`;
  return `poll failed: ${failure.failure}`;
}

// A profile dir with no login, such as one made before its first login, has nothing to poll;
// `status` still reports it. Failing on it would fail every timer tick.
function skippedText(entry: PollAllEntry): string | null {
  if (entry.result.ok) return null;
  if (entry.result.failure === "missing") return "no login, skipped";
  if (entry.result.failure !== "backoff" || entry.backoffUntil === undefined) return null;
  return `rate limited, skipped until ${new Date(entry.backoffUntil * 1000).toISOString()}`;
}

const ACCOUNT_LABELS_ENV = "ANTHROPIC_ACCOUNT_LABELS";

// Unset or empty means every profile is an account. A listed set marks the rest, such as a
// stray config dir, as not worth failing the timer over.
function accountLabelsOf(context: CliContext): ReadonlySet<string> | null {
  const labels = (context.env[ACCOUNT_LABELS_ENV] ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  return labels.length === 0 ? null : new Set(labels);
}

function isIgnorableLoginFailure(result: PollAllEntry["result"]): boolean {
  return !result.ok && (result.failure === "missing" || result.failure === "refused");
}

function reportEntry(entry: PollAllEntry, context: CliContext, accounts: ReadonlySet<string> | null): number {
  const { label, result } = entry;
  if (accounts !== null && !accounts.has(label) && isIgnorableLoginFailure(result) && !result.ok) {
    context.err(failureLine(label, `${failureText(result)}, not a listed account, ignored`));
    return EXIT_OK;
  }
  const skipped = skippedText(entry);
  if (skipped !== null) {
    context.out(`${printableLabel(label)}: ${skipped}`);
    return EXIT_OK;
  }
  if (!result.ok) {
    context.err(failureLine(label, failureText(result)));
    return ["expired", "refused"].includes(result.failure) ? EXIT_LOGIN : EXIT_FAILED;
  }
  const written = entry.file === undefined ? "" : " (written)";
  context.out(`${printableLabel(label)}: ${windowsText(result.reading.rate_limits)}${written}`);
  if (entry.writeError === undefined) return EXIT_OK;
  context.err(failureLine(label, "writing the usage reading failed"));
  return EXIT_FAILED;
}

async function pollEntries(profiles: AccountProfile[], write: boolean, options: PollOptions): Promise<PollAllEntry[]> {
  if (write) return pollAll({ ...options, profiles });
  const results = await Promise.all(
    profiles.map(async (profile) => ({ label: profile.label, result: await pollUsage(profile, options) })),
  );
  return results;
}

// Refreshes first, when asked, so a token renewed this run is the one polled. On darwin the
// login lives in the Keychain, which this never writes: renewal is left to Claude Code.
export async function runPoll(flags: PollFlags, context: CliContext): Promise<number> {
  const profiles = profilesOf(context);
  const now = context.now();
  const refresh = flags.refresh && (context.platform ?? process.platform) !== "darwin";
  const refreshCodes = refresh ? await refreshAll(profiles, now, context) : [];
  const options: PollOptions = { ...keychainOf(context), fetch: fetchOf(context), now, uid: context.uid };
  const entries = await pollEntries(profiles, flags.write, options);
  return exitFor([...refreshCodes, ...entries.map((entry) => reportEntry(entry, context, accountLabelsOf(context)))]);
}
