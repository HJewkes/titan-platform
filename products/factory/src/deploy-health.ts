import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { GitBehind } from "./deploy-behind.js";
import { DEPLOY_MAX_WAIT_MS } from "./shepherd/deploy-pacer.js";

const REFUSALS_TO_ALARM = 2;
const BEHIND_MERGES_TO_ALARM = 3;
const BEHIND_MINUTES_TO_ALARM = 60;
/** A burst of green merges asks for several deploys at once, and one deploy with its build takes minutes; an ask younger than this has not had its chance. */
const DEPLOY_GRACE_MS = 20 * 60_000;
const REASON_MAX_CHARS = 1_000;

/**
 * One line of redeploy.log that matters. `ask` is a start line: Shepherd spawns one only after a merge's main CI is
 * green, so it is the deployer being asked to land `target`. Outcome lines carry no time, so `at` is the last start
 * line before them. `superseded` is a refusal because a newer target already landed, so nothing stalled. An `ok`
 * carries the sha it landed.
 */
type LogEntry =
  | { kind: "ask"; at: string; target: string }
  | { kind: "ok" | "refused" | "superseded"; at: string | null; text: string; target?: string };

type Outcome = Exclude<LogEntry, { kind: "ask" }>;
type Ask = Extract<LogEntry, { kind: "ask" }>;

interface DeployHealthInput {
  entries: readonly LogEntry[];
  runningSha: string;
  now: number;
  /** The index.lock report, appended to a refusal that names index.lock. */
  lockNote?: string;
  /** Asked targets the running build descends from, as git proved in the deploy checkout. */
  held?: ReadonlySet<string>;
  /** Why ancestry could not be proved for some asks; those stay behind. */
  unverified?: string;
  /** The pacer's target, when it holds one the running build lacks; the minute alarms then wait for its cap. */
  wanted?: HeldWanted;
}

/** The deploy block of `/health` and `shepherd status`. */
export interface DeployHealth {
  runningSha: string;
  /** Deploys asked for (or held by the pacer) at least `DEPLOY_GRACE_MS` ago and not yet landed, or origin/main's commits past the running build once `status` has read git (`originLag`); the larger wins. */
  behind: number;
  /** Minutes since the oldest ask (or origin/main commit, once git is read) that has not landed; 0 when none is waiting. */
  behindMinutes: number;
  /** Set from git by serve's watch while no deploy is queued, else by `shepherd status`: commits on origin/main older than the grace that the running build lacks, asked for or not. */
  originLag?: { merges: number; minutes: number; asked: number };
  consecutiveRefusals: number;
  lastRefusal: { at: string | null; reason: string } | null;
  alarm: boolean;
  causes: string[];
  /** Set when git could not say whether the running build holds an ask, so the block counts it behind rather than guess. */
  unverified?: string;
  /** When the pacer's 90-min cap deploys the target it holds (`firstAt` + max wait), ISO; set only while it holds one the running build lacks. */
  capAt?: string;
}

const START = /^(\d{4}-\d\d-\d\dT\S+Z) service deploy --expect ([0-9a-f]{7,})\b/;
/** `already deployed: build B contains T` landed T: the running build already holds it. */
const OK = /^(?:(?:deployed|skipped) ([0-9a-f]{7,})\b|already deployed: build \S+ contains ([0-9a-f]{7,})\b)/;
const REFUSED = /^(?:error: (?:deploy refused:|deploy held:|rolled-back )|deployer did not start)/;
/** deploy.ts's pastTarget: the checkout already landed a newer commit that is on origin/main, so this ask arrived out of order. */
const SUPERSEDED = /^error: deploy refused: the checkout's main is at \S+, already past \S+; deploy that commit instead/;
/** Lines that close a refusal's detail: progress, another error, or a new start. */
const CLOSES = /^(?:error: |deploying |\d{4}-\d\d-\d\dT)/;

function kindOf(line: string): Outcome["kind"] | undefined {
  if (OK.test(line)) return "ok";
  if (SUPERSEDED.test(line)) return "superseded";
  return REFUSED.test(line) ? "refused" : undefined;
}

/**
 * Concurrent deployers share the log, so outcomes are read line by line rather than per start line.
 * A lock refusal means another deployer owns the attempt, so it is no outcome.
 */
export function parseRedeployLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let at: string | null = null;
  let open: Outcome | undefined;
  for (const line of text.split("\n")) {
    const ask = START.exec(line);
    if (ask) {
      at = ask[1]!;
      entries.push({ kind: "ask", at, target: ask[2]! });
    }
    const kind = kindOf(line);
    if (open && kind === undefined && line !== "" && !CLOSES.test(line)) {
      open.text = `${open.text}\n${line}`.slice(0, REASON_MAX_CHARS);
      continue;
    }
    const landed = OK.exec(line);
    open = kind === undefined ? undefined : { kind, at, text: line.replace(/^error: /, ""), ...(landed && { target: (landed[1] ?? landed[2])! }) };
    if (open) entries.push(open);
  }
  return entries;
}

export const namesIndexLock = (reason: string): boolean => reason.includes("index.lock");

const outcomesOf = (entries: readonly LogEntry[]): Outcome[] => entries.filter((entry): entry is Outcome => entry.kind === "ok" || entry.kind === "refused");

/** A landing of `target`, placed at log position `index`. */
interface Landing {
  index: number;
  target: string;
}

/** Each target's last ask position. */
function askPositions(entries: readonly LogEntry[]): Map<string, number> {
  const askedAt = new Map<string, number>();
  for (const [index, entry] of entries.entries()) if (entry.kind === "ask") askedAt.set(entry.target, index);
  return askedAt;
}

/**
 * Every proof that serve caught up, and the only one: logged landings, plus the running build. A fix made by hand
 * never writes to redeploy.log, so the running build counts as the deployer of every ask it holds (its own sha, or
 * one it descends from) having landed, placed where that ask's outcome lines end (the next ask).
 */
function landingsOf(entries: readonly LogEntry[], askedAt: ReadonlyMap<string, number>, held: ReadonlySet<string>): Landing[] {
  const logged = entries.flatMap((entry, index) => (entry.kind === "ok" && entry.target !== undefined ? [{ index, target: entry.target }] : []));
  const byRunning = [...held].flatMap((target) => {
    const asked = askedAt.get(target);
    if (asked === undefined) return [];
    const nextAsk = entries.findIndex((entry, index) => index > asked && entry.kind === "ask");
    return [{ index: nextAsk === -1 ? entries.length : nextAsk, target }];
  });
  return [...logged, ...byRunning];
}

/** Refusals since the last landing; superseded ones are no refusal. */
function refusalStreak(entries: readonly LogEntry[], landings: readonly Landing[]): number {
  const since = Math.max(-1, ...landings.map((landing) => landing.index));
  return entries.filter((entry, index) => index > since && entry.kind === "refused").length;
}

/** The last refused outcome, superseded ones aside. */
export function lastRefused(entries: readonly LogEntry[]): Outcome | undefined {
  return outcomesOf(entries).reverse().find((outcome) => outcome.kind === "refused");
}

function lastRefusal(entries: readonly LogEntry[], lockNote: string | undefined): DeployHealth["lastRefusal"] {
  const last = lastRefused(entries);
  if (!last) return null;
  const note = lockNote !== undefined && namesIndexLock(last.text) ? `\n${lockNote}` : "";
  return { at: last.at, reason: `${last.text}${note}` };
}

/**
 * `service deploy --expect T` lands exactly T, so an ask is covered only by a later landing of its own target or of a
 * target asked at or after it; position in the log alone proves nothing, since a burst's lock losers never deploy.
 */
function uncoveredAsks(entries: readonly LogEntry[], askedAt: ReadonlyMap<string, number>, landings: readonly Landing[]): Ask[] {
  const covered = (target: string, index: number): boolean =>
    landings.some((landing) => landing.index > index && (landing.target === target || (askedAt.get(landing.target) ?? -1) >= index));
  return entries.flatMap((entry, index) => (entry.kind === "ask" && !covered(entry.target, index) ? [entry] : []));
}

/** The target the pacer holds in deploy-wanted.json, wanted since `firstAt`. */
export interface HeldWanted {
  sha: string;
  firstAt: string;
}

/**
 * A target the pacer holds has asked as surely as a logged start line, though the pacer writes none while it waits;
 * it joins as an ask at `firstAt`, last in the log so only the running build can cover it. A logged ask of its sha
 * already counts it.
 */
export function withWanted(entries: readonly LogEntry[], wanted: HeldWanted | undefined): LogEntry[] {
  if (wanted === undefined || entries.some((entry) => entry.kind === "ask" && entry.target === wanted.sha)) return [...entries];
  return [...entries, { kind: "ask", at: wanted.firstAt, target: wanted.sha }];
}

/** Targets of asks still waiting once only equal shas count; the caller proves which of them the running build descends from. */
export function targetsToProve(entries: readonly LogEntry[], runningSha: string): string[] {
  const askedAt = askPositions(entries);
  const landings = landingsOf(entries, askedAt, new Set([runningSha]));
  return [...new Set(uncoveredAsks(entries, askedAt, landings).map((entry) => entry.target))];
}

function waiting(uncovered: readonly Ask[], now: number): Pick<DeployHealth, "behind" | "behindMinutes"> {
  if (uncovered.length === 0) return { behind: 0, behindMinutes: 0 };
  const asks = uncovered.map((entry) => Date.parse(entry.at));
  const behind = asks.filter((at) => now - at >= DEPLOY_GRACE_MS).length;
  return { behind, behindMinutes: Math.max(0, Math.floor((now - Math.min(...asks)) / 60_000)) };
}

/**
 * The minute alarms count from the oldest commit serve lacks, but a pacer that holds a target waits until its cap,
 * counted from `firstAt`; while it holds one they wait for the cap too, so the alarm cannot pass the pacer's own bound.
 */
function pastLimit(health: Pick<DeployHealth, "capAt">, minutes: number, now: number): boolean {
  return health.capAt === undefined ? minutes > BEHIND_MINUTES_TO_ALARM : now >= Date.parse(health.capAt);
}

function alarmCauses(health: Omit<DeployHealth, "alarm" | "causes">, now: number): string[] {
  const { consecutiveRefusals: refusals, behind, behindMinutes, runningSha } = health;
  const causes: string[] = [];
  if (refusals >= REFUSALS_TO_ALARM) causes.push(`service deploy refused ${refusals} times in a row; last: ${health.lastRefusal?.reason.split("\n")[0] ?? ""}`);
  if (behind > BEHIND_MERGES_TO_ALARM) causes.push(`serve runs ${runningSha}, and ${behind} green merges asked to deploy have not landed`);
  if (pastLimit(health, behindMinutes, now)) causes.push(`a deploy asked for ${behindMinutes} min ago has not landed`);
  return causes;
}

/**
 * Folds git's reading of origin/main into the block as a lag of its own: commits main holds that the running build
 * lacks, whether or not anyone asked for a deploy. Commits younger than `DEPLOY_GRACE_MS` are not counted, as with
 * asks, since a burst of merges has not had its chance. A reading git could not give alarms rather than reads as 0.
 */
export function withGitBehind(health: DeployHealth, git: GitBehind, now: number): DeployHealth {
  if ("unknown" in git) {
    const cause = `serve's lag behind origin/main is unknown: ${git.unknown}`;
    return { ...health, alarm: true, causes: [...health.causes, cause], unverified: health.unverified ?? cause };
  }
  const aged = git.commitTimes.filter((at) => now - at >= DEPLOY_GRACE_MS);
  const merges = aged.length;
  const minutes = merges === 0 ? 0 : Math.max(0, Math.floor((now - Math.min(...aged)) / 60_000));
  const causes = [...health.causes, ...gitCauses(merges, pastLimit(health, minutes, now), minutes, health.runningSha)];
  const originLag = { merges, minutes, asked: health.behind };
  return { ...health, behind: Math.max(health.behind, merges), behindMinutes: Math.max(health.behindMinutes, minutes), originLag, alarm: causes.length > 0, causes };
}

function gitCauses(merges: number, minutesPast: boolean, minutes: number, runningSha: string): string[] {
  const causes: string[] = [];
  if (merges > BEHIND_MERGES_TO_ALARM) causes.push(`origin/main holds ${merges} commits that serve (${runningSha}) does not run`);
  if (minutesPast) causes.push(`origin/main has held a commit serve does not run for ${minutes} min`);
  return causes;
}

/**
 * Judges the deployer only on what it was asked to land: two refusals in a row, more than 3 asks past their grace,
 * or an ask over 60 minutes old with nothing landed since. A merge that never asked is no deploy failure here;
 * `withGitBehind` reports those as origin lag.
 */
export function deployHealth(input: DeployHealthInput): DeployHealth {
  const askedAt = askPositions(input.entries);
  const landings = landingsOf(input.entries, askedAt, new Set([input.runningSha, ...(input.held ?? [])]));
  const base = {
    runningSha: input.runningSha,
    ...waiting(uncoveredAsks(input.entries, askedAt, landings), input.now),
    consecutiveRefusals: refusalStreak(input.entries, landings),
    lastRefusal: lastRefusal(input.entries, input.lockNote),
    ...(input.wanted !== undefined && { capAt: new Date(Date.parse(input.wanted.firstAt) + DEPLOY_MAX_WAIT_MS).toISOString() }),
  };
  const causes = alarmCauses(base, input.now);
  return { ...base, alarm: causes.length > 0, causes, ...(input.unverified !== undefined && { unverified: input.unverified }) };
}

/** The one message the hub seat gets when the alarm goes up. */
export const alarmMessage = (health: DeployHealth): string =>
  `titan-factory deploy alarm: ${health.causes.join("; ")}. titan-factory shepherd status shows the deploy block.`;

/** The human summary line `shepherd status` prints under its rows. */
export function deploySummary(health: DeployHealth): string {
  const cap = health.capAt === undefined ? "" : `, cap ${new Date(health.capAt).toISOString().slice(11, 16)}Z`;
  const state = health.alarm ? `ALARM: ${health.causes.join("; ")}` : "ok";
  const unverified = health.unverified === undefined ? "" : `; ${health.unverified}`;
  const lag = !health.originLag?.merges ? "" : `, origin/main ${health.originLag.merges} commit(s) ahead (${health.originLag.minutes} min)`;
  const asked = health.originLag?.asked ?? health.behind;
  return `deploy: running ${health.runningSha}, ${asked} asked deploy(s) not landed${lag}${cap}, ${health.consecutiveRefusals} refusal(s) in a row; ${state}${unverified}\n`;
}

/** The deploy block from a `/health` answer; null when serve answered none or keeps none. */
export function deployBlockOf(health: Record<string, unknown> | null): DeployHealth | null {
  const block = health?.deploy;
  return isDeployHealth(block) ? block : null;
}

const isDeployHealth = (block: unknown): block is DeployHealth => isObjectLike(block) && typeof block.alarm === "boolean" && Array.isArray(block.causes) && typeof block.runningSha === "string";
