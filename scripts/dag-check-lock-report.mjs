// Reports, per owner (worktree hash), how long dag-check waiters kept giving up with exit 75 inside a time window.
// Usage: node scripts/dag-check-lock-report.mjs --since 2h [--lock-dir <dir>]
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_LOCK_DIR, readBusy, readHolds } from "./dag-check-lock.mjs";

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/** A window like "90m", "2h" or "1d" in ms; throws on anything else. */
export function parseSince(text) {
  const [, count, unit] = /^(\d+)([smhd])$/.exec(text ?? "") ?? [];
  if (!unit) throw new Error(`--since wants a number and a unit s, m, h or d (got ${JSON.stringify(text)})`);
  return Number(count) * UNIT_MS[unit];
}

// The hold log does not name the owner, so a hold cannot be matched to one worktree. Any hold acquired between two of an
// owner's busy lines counts as the lock making progress and ends that owner's streak.
function longestStreak(busyTimes, holdTimes) {
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const at of busyTimes) {
    const interrupted = previous !== null && holdTimes.some((held) => held > previous && held < at);
    run = interrupted ? 1 : run + 1;
    longest = Math.max(longest, run);
    previous = at;
  }
  return longest;
}

/** One row per owner with a busy line since `since`: its longest streak, busy total and the window's hold count. */
export function buildReport(lockDir, since) {
  const busy = readBusy(lockDir).filter((line) => line.at >= since);
  const holdTimes = readHolds(lockDir).filter((hold) => hold.acquiredAt >= since).map((hold) => hold.acquiredAt);
  const byOwner = new Map();
  for (const line of busy) {
    const owner = String(line.owner ?? "unknown");
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), line.at]);
  }
  return [...byOwner].map(([owner, times]) => ({
    owner,
    longestStreak: longestStreak(times.sort((a, b) => a - b), holdTimes),
    busy: times.length,
    holds: holdTimes.length,
  }));
}

export function formatReport(rows) {
  const header = "owner\tlongest_streak\tbusy\tholds";
  return [header, ...rows.map((row) => `${row.owner}\t${row.longestStreak}\t${row.busy}\t${row.holds}`)].join("\n");
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { since: { type: "string" }, "lock-dir": { type: "string" } } });
  const since = Date.now() - parseSince(values.since ?? "2h");
  const rows = buildReport(values["lock-dir"] ?? DEFAULT_LOCK_DIR, since);
  console.log(formatReport(rows.sort((a, b) => b.longestStreak - a.longestStreak)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
