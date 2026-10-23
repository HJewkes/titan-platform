import { join } from "node:path";
import type { Logger } from "@titan-design/daemon";
import type { CheckRun, GitHubPort } from "@titan-design/github";
import type { ShepherdServices } from "./services.js";
import { failureOf } from "./error-class.js";
import { singleSeat } from "./held-repair.js";
import { MAIN_WATCH_DB, MainWatchLedger, type WatchedSha } from "./main-watch-ledger.js";
import { judgeMain, readMainRules, type MainRules } from "./main-verdict.js";
import { resolveEffectivePolicy } from "./policy.js";
import { lookupSeat, type SeatBook } from "./seats.js";
import type { ShepherdStore } from "./store.js";

/** How often serve reads each watched repo's main; one listing per repo, plus one check-run read per unsettled sha. */
export const MAIN_WATCH_MS = 5 * 60_000;

/** How far back main is read, and how long a sha may stay unread before it goes quiet: longer than post-merge's longest wait. */
export const MAIN_WATCH_WINDOW_MS = 6 * 3_600_000;

interface SharedRead {
  at: number;
  runs: Promise<readonly CheckRun[]>;
}

/**
 * Post-merge's per-repo ledger of main CI reads. Every run polling a repo's main shares one check-run read per sha per
 * `freshMs`, so several live runs on one tip cost what one does. A failed read is dropped, so the next poll reads again.
 */
export class MainCiReads {
  private readonly repos = new Map<string, Map<string, SharedRead>>();

  constructor(
    private readonly port: Pick<GitHubPort, "checkRuns">,
    private readonly now: () => number,
    private readonly freshMs: number,
  ) {}

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const reads = this.ledgerOf(repo);
    const now = this.now();
    for (const [key, read] of reads) if (now - read.at >= this.freshMs) reads.delete(key);
    let read = reads.get(sha);
    if (read === undefined) {
      const fresh: SharedRead = { at: now, runs: this.port.checkRuns(repo, sha) };
      fresh.runs.catch(() => reads.get(sha) === fresh && reads.delete(sha));
      reads.set(sha, (read = fresh));
    }
    return [...(await read.runs)];
  }

  /** `port` with its check-run reads answered through this ledger. */
  over(port: GitHubPort): GitHubPort {
    return { ...port, checkRuns: (repo, sha) => this.checkRuns(repo, sha) };
  }

  private ledgerOf(repo: string): Map<string, SharedRead> {
    const key = repo.toLowerCase();
    let reads = this.repos.get(key);
    if (reads === undefined) this.repos.set(key, (reads = new Map()));
    return reads;
  }
}

/** Where a red event goes and how it is sent; absent from serve, nothing watches main outside a Shepherd run. */
export interface MainWatchPorts {
  /** The config's shepherd.hubSeat: told about a red merge no seat can be found for. */
  hubSeat(): string | undefined;
  /** The config's shepherd.redSeat for `repo`: when set, every red event on it goes there, whichever seat owns the merge. */
  redSeat?(repo: string): string | undefined;
  send(seat: string, text: string): Promise<void>;
  /** The names `send` can reach now, by the send's own rule; absent, no red-event seat is checked. */
  liveNames?(): Promise<ReadonlySet<string>>;
}

export interface MainWatchDeps {
  port: GitHubPort;
  ledger: MainWatchLedger;
  store: Pick<ShepherdStore, "byPr">;
  seats: () => SeatBook;
  ports: MainWatchPorts;
  now: () => number;
}

interface MainWatchNote {
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
  let alarmed = "";
  let unread = false;
  const alarmOnChange = async (repos: readonly string[]): Promise<void> => {
    const alarms = await deadRedSeats(services.seats(), repos, ports).catch((error: unknown) => {
      if (!unread) log.warn({ error: failureOf(error) }, "main CI watch skipped its dead-seat check: the agent-chat roster could not be read");
      unread = true;
    });
    if (alarms === undefined) return;
    unread = false;
    const key = alarms.map((alarm) => `${alarm.seat}:${alarm.repos.join(",")}`).join("\n");
    if (key === alarmed) return;
    alarmed = key;
    for (const alarm of alarms) log.error({ ...alarm }, `main CI watch ALARM: red events go to seat ${alarm.seat}, which no live agent-chat session holds`);
  };
  const tick = async (): Promise<void> => {
    const repos = watchedRepos(services.seats());
    await alarmOnChange(repos);
    for (const note of await sweepMain(deps, repos)) {
      if (note.outcome === "sent") log.info({ ...note }, "main CI watch sent a red event");
      else log.warn({ ...note }, "main CI watch");
    }
  };
  return { tick, close: () => ledger.close() };
}

/** Every seat's owned remotes, once each: the repos whose main a merge can land on outside a run. */
function watchedRepos(book: SeatBook): string[] {
  return [...new Set(book.seats.flatMap((seat) => seat.remotes))];
}

/** A red-event seat no live session holds, with the repos whose red merges it is sent; none means it stands in as the hub seat. */
interface DeadSeat {
  seat: string;
  repos: string[];
}

/**
 * The seats `ownerSeat` sends each repo's red events to: a run registered now, through the seat its policy records,
 * and a merge no seat can be mapped to. A branch-prefix seat is left out; it is chosen per PR from the whole book.
 */
async function redEventSeats(book: SeatBook, repos: readonly string[], ports: MainWatchPorts): Promise<Map<string, string[]>> {
  const seats = new Map<string, string[]>();
  const none = async () => undefined;
  for (const repo of repos) {
    for (const seat of new Set([await redRoute(ports, repo, registeredSeat(book, repo), none), await redRoute(ports, repo, undefined, none)])) {
      if (seat !== undefined) seats.set(seat, [...(seats.get(seat) ?? []), repo]);
    }
  }
  return seats;
}

/** Where a red event about `repo` with no merge behind it goes, by the red event's own route: a hand thaw's alert. */
export function repoRedSeat(book: SeatBook, repo: string, ports: Pick<MainWatchPorts, "hubSeat" | "redSeat">): Promise<string | undefined> {
  return redRoute(ports, repo, registeredSeat(book, repo), async () => undefined);
}

/** The seat a run registered on `repo` now records, by registration's own policy; a denied repo registers none. */
function registeredSeat(book: SeatBook, repo: string): string | undefined {
  const lookup = lookupSeat(book, repo);
  return lookup.kind === "denied" ? undefined : singleSeat(resolveEffectivePolicy(lookup).seat);
}

/**
 * Every red-event seat with no live agent-chat session, so a send that can only fail is reported as a dead route
 * rather than retried quietly each sweep. A roster that cannot be read throws, and never reads as every seat dead.
 */
export async function deadRedSeats(book: SeatBook, repos: readonly string[], ports: MainWatchPorts): Promise<DeadSeat[]> {
  if (ports.liveNames === undefined) return [];
  const live = await ports.liveNames();
  return [...(await redEventSeats(book, repos, ports))].filter(([seat]) => !live.has(seat)).map(([seat, owned]) => ({ seat, repos: owned }));
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
function verdictAt(sha: string, runs: readonly CheckRun[], rules: MainRules | undefined): Verdict {
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

function redEventText(repo: string, sha: string, pr: number | undefined, failing: readonly string[]): string {
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
 * A repo with a configured red seat sends every red event there. Otherwise a merge from a Shepherd run goes to the seat
 * the run names, as its seat notices do. Any other merge goes to the seat
 * whose initials prefix the PR's agent branch (`agent-chat/tc-...` to a seat named `t...-c...`), else to the hub seat.
 */
async function ownerSeat(deps: MainWatchDeps, repo: string, pr: number | undefined): Promise<string | undefined> {
  const registration = pr === undefined ? undefined : deps.store.byPr(repo, pr);
  const prefixSeat = async () => {
    const branch = registration?.implementer ?? (pr === undefined ? undefined : await deps.port.getPr(repo, pr).then((read) => read.headRef, () => undefined));
    return branch === undefined ? undefined : seatByPrefix(deps.seats(), branch);
  };
  return redRoute(deps.ports, repo, singleSeat(registration?.policy.seat), prefixSeat);
}

/** The one order a red event's seat is picked in, for the send and the dead-seat alarm alike; the prefix seat is read only when needed. */
async function redRoute(ports: Pick<MainWatchPorts, "hubSeat" | "redSeat">, repo: string, runSeat: string | undefined, prefixSeat: () => Promise<string | undefined>): Promise<string | undefined> {
  return ports.redSeat?.(repo) ?? runSeat ?? (await prefixSeat()) ?? ports.hubSeat();
}

const initials = (name: string): string => name.split("-").map((part) => part.charAt(0)).join("").toLowerCase();

/** The one seat whose initials are the agent name's first hyphen part; two seats with the same initials name neither. */
export function seatByPrefix(book: SeatBook, branch: string): string | undefined {
  const prefix = branch.slice(branch.lastIndexOf("/") + 1).split("-", 1)[0]!.toLowerCase();
  const names = [...new Set(book.seats.map((seat) => seat.name))].filter((name) => initials(name) === prefix);
  return prefix.length > 1 && names.length === 1 ? names[0] : undefined;
}
