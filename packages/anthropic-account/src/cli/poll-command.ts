import type { AccountProfile } from "../profile.js";
import { pollAll, pollUsage, type PollAllEntry, type PollFailure, type PollOptions } from "../node/poll.js";
import { refreshIfNeeded, type RefreshResult } from "../node/refresh.js";
import { fetchOf, profilesOf, type CliContext } from "./context.js";
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
  const results = await Promise.all(profiles.map((profile) => refreshIfNeeded(profile, options)));
  return results.map((result, index) => reportRefresh(profiles[index] as AccountProfile, result, context));
}

function failureText(failure: PollFailure): string {
  if (failure.failure === "refused") return `login refused (${failure.reason})`;
  if (failure.failure === "missing" || failure.failure === "expired") return `login ${failure.failure}`;
  return `poll failed: ${failure.failure}`;
}

function reportEntry(entry: PollAllEntry, context: CliContext): number {
  const { label, result } = entry;
  if (!result.ok) {
    context.err(failureLine(label, failureText(result)));
    return ["missing", "expired", "refused"].includes(result.failure) ? EXIT_LOGIN : EXIT_FAILED;
  }
  const written = entry.file === undefined ? "" : " (written)";
  context.out(`${printableLabel(label)}: ${windowsText(result.reading.rate_limits)}${written}`);
  if (entry.writeError === undefined) return EXIT_OK;
  context.err(failureLine(label, "writing the usage reading failed"));
  return EXIT_FAILED;
}

async function pollEntries(profiles: AccountProfile[], write: boolean, options: PollOptions): Promise<PollAllEntry[]> {
  if (write) return pollAll({ ...options, profiles });
  const results = await Promise.all(profiles.map((profile) => pollUsage(profile, options)));
  return results.map((result, index) => ({ label: (profiles[index] as AccountProfile).label, result }));
}

// Refreshes first, when asked, so a token renewed this run is the one polled.
export async function runPoll(flags: PollFlags, context: CliContext): Promise<number> {
  const profiles = profilesOf(context);
  const now = context.now();
  const refreshCodes = flags.refresh ? await refreshAll(profiles, now, context) : [];
  const options: PollOptions = { fetch: fetchOf(context), now, uid: context.uid };
  const entries = await pollEntries(profiles, flags.write, options);
  return exitFor([...refreshCodes, ...entries.map((entry) => reportEntry(entry, context))]);
}
