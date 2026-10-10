import { join } from "node:path";
import type { Logger } from "@titan-design/daemon";
import type { CheckRun, GitHubPort } from "@titan-design/github";
import type { ShepherdServices } from "./commands.js";
import { failureOf } from "./error-class.js";
import { singleSeat } from "./held-repair.js";
import { MAIN_WATCH_DB, MainWatchLedger, type WatchedSha } from "./main-watch-ledger.js";
import { judgeMain, readMainRules, type MainRules } from "./main-verdict.js";
import type { SeatBook } from "./seats.js";
import type { ShepherdStore } from "./store.js";

/** How often serve reads each watched repo's main; one listing per repo, plus one check-run read per unsettled sha. */
export const MAIN_WATCH_MS = 5 * 60_000;

/** How far back main is read, and how long a sha may stay unread before it goes quiet: longer than post-merge's longest wait. */
export const MAIN_WATCH_WINDOW_MS = 6 * 3_600_000;

/** Where a red event goes and how it is sent; absent from serve, nothing watches main outside a Shepherd run. */
export interface MainWatchPorts {
  /** The config's shepherd.hubSeat: told about a red merge no seat can be found for. */
  hubSeat(): string | undefined;
  send(seat: string, text: string): Promise<void>;
}

export interface MainWatchDeps {
  port: GitHubPort;
  ledger: MainWatchLedger;
  store: Pick<ShepherdStore, "byPr">;
  seats: () => SeatBook;
  ports: MainWatchPorts;
  now: () => number;
}

export interface MainWatchNote {
  repo: string;
  sha: string;
  outcome: "sent" | "unsent" | "expired" | "error";
  detail: string;
  seat?: string;
}

/** Serve's watch: its ledger beside the factory database, and a tick that logs each event sent and each problem. */
export function openMainWatch(services: ShepherdServices, ports: MainWatchPorts, stateDir: string, log: Logger): { tick: () => Promise<void>; close: () => void } {
  const ledger = MainWatchLedger.open(join(stateDir, MAIN_WATCH_DB));
  const deps: MainWatchDeps = { port: services.port, ledger, store: { byPr: (repo, pr) => services.store.get().byPr(repo, pr) }, seats: services.seats, ports, now: Date.now };
  const tick = async (): Promise<void> => {
    for (const note of await sweepMain(deps, watchedRepos(services.seats()))) {
      if (note.outcome === "sent") log.info({ ...note }, "main CI watch sent a red event");
      else log.warn({ ...note }, "main CI watch");
    }
  };
  return { tick, close: () => ledger.close() };
}

/** Every seat's owned remotes, once each: the repos whose main a merge can land on outside a run. */
export function watchedRepos(book: SeatBook): string[] {
  return [...new Set(book.seats.flatMap((seat) => seat.remotes))];
}

/**
 * Reads every merge on each repo's main, Shepherd's or not, and stays silent while its CI is green, cancelled or unread.
 * A red sha sends its owning seat one event; a failed send is retried each sweep, and a repo that cannot be read is
 * reported and read again next sweep.
 */
export async function sweepMain(deps: MainWatchDeps, repos: readonly string[]): Promise<MainWatchNote[]> {
  const notes: MainWatchNote[] = [];
  for (const repo of repos) {
    try {
      notes.push(...(await watchRepo(deps, repo)));
    } catch (error) {
      notes.push({ repo, sha: "", outcome: "error", detail: failureOf(error) });
    }
  }
  return notes;
}

async function watchRepo(deps: MainWatchDeps, repo: string): Promise<MainWatchNote[]> {
  const now = deps.now();
  const since = Math.max(deps.ledger.startOf(repo, now), now - MAIN_WATCH_WINDOW_MS);
  for (const commit of await deps.port.listDefaultBranchCommits(repo, new Date(since).toISOString())) deps.ledger.watch(repo, commit.sha, subjectOf(commit.message), now);
  const notes: MainWatchNote[] = [];
  const watching = deps.ledger.inState(repo, "watching");
  if (watching.length > 0) {
    const { rules } = await readMainRules(deps.port, repo, await deps.port.defaultBranch(repo));
    for (const row of watching) notes.push(...(await judgeSha(deps, repo, row, rules, now)));
  }
  for (const row of deps.ledger.inState(repo, "red")) notes.push(await deliver(deps, repo, row, now));
  return notes;
}

type Verdict = { kind: "green" | "pending" | "cancelled" } | { kind: "red"; failing: string[] };

/** As post-merge reads main: the required contexts judge, a cancel a newer run superseded is dropped, and an all-cancelled red is no red. */
export function verdictAt(sha: string, runs: readonly CheckRun[], rules: MainRules | undefined): Verdict {
  const { findings, counted } = judgeMain(sha, runs, rules);
  if (counted === 0) return { kind: "pending" };
  const failed = findings.flatMap((finding) => (finding.kind === "failed" ? [finding.run] : []));
  if (failed.length > 0 && failed.every((run) => run.conclusion === "cancelled")) return { kind: "cancelled" };
  if (failed.length > 0) return { kind: "red", failing: [...new Set(failed.map((run) => run.name))] };
  return { kind: findings.length > 0 ? "pending" : "green" };
}

async function judgeSha(deps: MainWatchDeps, repo: string, row: WatchedSha, rules: MainRules | undefined, now: number): Promise<MainWatchNote[]> {
  const verdict = verdictAt(row.sha, await deps.port.checkRuns(repo, row.sha), rules);
  if (verdict.kind === "red") deps.ledger.markRed(repo, row.sha, verdict.failing);
  else if (verdict.kind !== "pending") deps.ledger.settle(repo, row.sha, verdict.kind);
  else if (now - row.firstSeen > MAIN_WATCH_WINDOW_MS) {
    deps.ledger.settle(repo, row.sha, "expired");
    return [{ repo, sha: row.sha, outcome: "expired", detail: `no settled main CI run within ${MAIN_WATCH_WINDOW_MS / 3_600_000} h` }];
  }
  return [];
}

/** A red sha past the window that still has no seat or no send goes quiet, so a dead broker cannot make the sweep send forever. */
async function deliver(deps: MainWatchDeps, repo: string, row: WatchedSha, now: number): Promise<MainWatchNote> {
  const pr = prNumberOf(row.subject);
  const seat = await ownerSeat(deps, repo, pr);
  const stale = now - row.firstSeen > MAIN_WATCH_WINDOW_MS;
  if (seat === undefined) {
    deps.ledger.settle(repo, row.sha, "unsent");
    return { repo, sha: row.sha, outcome: "unsent", detail: "no seat owns the merge and shepherd.hubSeat is not set" };
  }
  try {
    await deps.ports.send(seat, redEventText(repo, row.sha, pr, row.failing));
    deps.ledger.settle(repo, row.sha, "sent", seat);
    return { repo, sha: row.sha, outcome: "sent", seat, detail: `told ${seat}` };
  } catch (error) {
    if (stale) deps.ledger.settle(repo, row.sha, "unsent", seat);
    return { repo, sha: row.sha, outcome: "unsent", seat, detail: `the red event failed${stale ? ", and the sha left the window" : "; the next sweep retries"}: ${failureOf(error)}` };
  }
}

export function redEventText(repo: string, sha: string, pr: number | undefined, failing: readonly string[]): string {
  const merged = pr === undefined ? "" : ` after PR #${pr}`;
  return [
    `Shepherd: main CI is red on ${repo} at ${sha}${merged}. Failing: ${failing.join(", ") || "no job named"}.`,
    "This is the one event for this sha. Shepherd sends nothing while main is green, so no seat needs to wait on main CI.",
  ].join("\n");
}

const subjectOf = (message: string): string => message.split("\n", 1)[0]!.trim();

/** A squash merge's ` (#n)` suffix, or a merge commit's `Merge pull request #n`. */
export function prNumberOf(subject: string): number | undefined {
  const match = /\(#(\d+)\)$/.exec(subject) ?? /^Merge pull request #(\d+) /.exec(subject);
  return match ? Number(match[1]) : undefined;
}

/**
 * A merge from a Shepherd run goes to the seat the run names, as its seat notices do. Any other merge goes to the seat
 * whose initials prefix the PR's agent branch (`agent-chat/tc-...` to a seat named `t...-c...`), else to the hub seat.
 */
async function ownerSeat(deps: MainWatchDeps, repo: string, pr: number | undefined): Promise<string | undefined> {
  const registration = pr === undefined ? undefined : deps.store.byPr(repo, pr);
  const runSeat = singleSeat(registration?.policy.seat);
  if (runSeat !== undefined) return runSeat;
  const branch = registration?.implementer ?? (pr === undefined ? undefined : await deps.port.getPr(repo, pr).then((read) => read.headRef, () => undefined));
  return (branch === undefined ? undefined : seatByPrefix(deps.seats(), branch)) ?? deps.ports.hubSeat();
}

const initials = (name: string): string => name.split("-").map((part) => part.charAt(0)).join("").toLowerCase();

/** The one seat whose initials are the agent name's first hyphen part; two seats with the same initials name neither. */
export function seatByPrefix(book: SeatBook, branch: string): string | undefined {
  const prefix = branch.slice(branch.lastIndexOf("/") + 1).split("-", 1)[0]!.toLowerCase();
  const names = [...new Set(book.seats.map((seat) => seat.name))].filter((name) => initials(name) === prefix);
  return prefix.length > 1 && names.length === 1 ? names[0] : undefined;
}
