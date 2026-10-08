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

interface DeployHealthInput {
  entries: readonly LogEntry[];
  runningSha: string;
  now: number;
  /** The index.lock report, appended to a refusal that names index.lock. */
  lockNote?: string;
}

/** The deploy block of `/health` and `shepherd status`. */
export interface DeployHealth {
  runningSha: string;
  /** Deploys asked for at least `DEPLOY_GRACE_MS` ago and not yet landed; merges that never asked (red or unshepherded) are not counted. */
  behind: number;
  /** Minutes since the oldest ask that has not landed; 0 when none is waiting. */
  behindMinutes: number;
  consecutiveRefusals: number;
  lastRefusal: { at: string | null; reason: string } | null;
  alarm: boolean;
  causes: string[];
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
 * never writes to redeploy.log, so the running build counts as its own ask's deployer having landed, placed where
 * that ask's outcome lines end (the next ask). A running build that was never asked lands nothing.
 */
function landingsOf(entries: readonly LogEntry[], askedAt: ReadonlyMap<string, number>, runningSha: string): Landing[] {
  const logged = entries.flatMap((entry, index) => (entry.kind === "ok" && entry.target !== undefined ? [{ index, target: entry.target }] : []));
  const runningAsk = askedAt.get(runningSha);
  if (runningAsk === undefined) return logged;
  const nextAsk = entries.findIndex((entry, index) => index > runningAsk && entry.kind === "ask");
  return [...logged, { index: nextAsk === -1 ? entries.length : nextAsk, target: runningSha }];
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
function uncoveredAsks(entries: readonly LogEntry[], askedAt: ReadonlyMap<string, number>, landings: readonly Landing[]): number[] {
  const covered = (target: string, index: number): boolean =>
    landings.some((landing) => landing.index > index && (landing.target === target || (askedAt.get(landing.target) ?? -1) >= index));
  return entries.flatMap((entry, index) => (entry.kind === "ask" && !covered(entry.target, index) ? [Date.parse(entry.at)] : []));
}

function waiting(asks: readonly number[], now: number): Pick<DeployHealth, "behind" | "behindMinutes"> {
  if (asks.length === 0) return { behind: 0, behindMinutes: 0 };
  const behind = asks.filter((at) => now - at >= DEPLOY_GRACE_MS).length;
  return { behind, behindMinutes: Math.max(0, Math.floor((now - Math.min(...asks)) / 60_000)) };
}

function alarmCauses(health: Omit<DeployHealth, "alarm" | "causes">): string[] {
  const { consecutiveRefusals: refusals, behind, behindMinutes, runningSha } = health;
  const causes: string[] = [];
  if (refusals >= REFUSALS_TO_ALARM) causes.push(`service deploy refused ${refusals} times in a row; last: ${health.lastRefusal?.reason.split("\n")[0] ?? ""}`);
  if (behind > BEHIND_MERGES_TO_ALARM) causes.push(`serve runs ${runningSha}, and ${behind} green merges asked to deploy have not landed`);
  if (behindMinutes > BEHIND_MINUTES_TO_ALARM) causes.push(`a deploy asked for ${behindMinutes} min ago has not landed`);
  return causes;
}

/**
 * Judges the deployer only on what it was asked to land: two refusals in a row, more than 3 asks past their grace,
 * or an ask over 60 minutes old with nothing landed since. A merge that never asked is no deploy failure.
 */
export function deployHealth(input: DeployHealthInput): DeployHealth {
  const askedAt = askPositions(input.entries);
  const landings = landingsOf(input.entries, askedAt, input.runningSha);
  const base = {
    runningSha: input.runningSha,
    ...waiting(uncoveredAsks(input.entries, askedAt, landings), input.now),
    consecutiveRefusals: refusalStreak(input.entries, landings),
    lastRefusal: lastRefusal(input.entries, input.lockNote),
  };
  const causes = alarmCauses(base);
  return { ...base, alarm: causes.length > 0, causes };
}

/** The one message the hub seat gets when the alarm goes up. */
export const alarmMessage = (health: DeployHealth): string =>
  `titan-factory deploy alarm: ${health.causes.join("; ")}. titan-factory shepherd status shows the deploy block.`;

/** The human summary line `shepherd status` prints under its rows. */
export function deploySummary(health: DeployHealth): string {
  const state = health.alarm ? `ALARM: ${health.causes.join("; ")}` : "ok";
  return `deploy: running ${health.runningSha}, ${health.behind} asked deploy(s) not landed, ${health.consecutiveRefusals} refusal(s) in a row; ${state}\n`;
}

/** The deploy block from a `/health` answer; null when serve answered none or keeps none. */
export function deployBlockOf(health: Record<string, unknown> | null): DeployHealth | null {
  const block = health?.deploy;
  if (typeof block !== "object" || block === null) return null;
  const { alarm, causes, runningSha } = block as Partial<DeployHealth>;
  return typeof alarm === "boolean" && Array.isArray(causes) && typeof runningSha === "string" ? (block as DeployHealth) : null;
}
