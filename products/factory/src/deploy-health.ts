export const REFUSALS_TO_ALARM = 2;
export const BEHIND_MERGES_TO_ALARM = 3;
export const BEHIND_MINUTES_TO_ALARM = 60;
const REASON_MAX_CHARS = 1_000;

/** One finished `service deploy` as redeploy.log shows it; `at` is the start line before it, since outcome lines carry no time. */
export interface LoggedOutcome {
  kind: "ok" | "refused";
  at: string | null;
  text: string;
}

/** How far main is past the running build: merges, and when the oldest one the build lacks landed. */
export interface MainLag {
  behind: number;
  oldestAt?: number;
}

export interface DeployHealthInput {
  outcomes: readonly LoggedOutcome[];
  runningSha: string;
  /** A string says why the lag could not be read. */
  lag: MainLag | string;
  now: number;
  /** The index.lock report, appended to a refusal that names index.lock. */
  lockNote?: string;
}

/** The deploy block of `/health` and `shepherd status`. */
export interface DeployHealth {
  runningSha: string;
  behind: number | null;
  behindMinutes: number | null;
  lagUnknown?: string;
  consecutiveRefusals: number;
  lastRefusal: { at: string | null; reason: string } | null;
  alarm: boolean;
  causes: string[];
}

const START = /^(\d{4}-\d\d-\d\dT\S+Z) service deploy\b/;
const OK = /^(?:(?:deployed|skipped) [0-9a-f]{7,}\b|already deployed:)/;
const REFUSED = /^(?:error: (?:deploy refused|deploy held|rolled-back) |deployer did not start)/;
/** Lines that close a refusal's detail: progress, another error, or a new start. */
const CLOSES = /^(?:error: |deploying |\d{4}-\d\d-\d\dT)/;

const kindOf = (line: string): LoggedOutcome["kind"] | undefined => (OK.test(line) ? "ok" : REFUSED.test(line) ? "refused" : undefined);

/**
 * Concurrent deployers share the log, so outcomes are read line by line rather than per start line.
 * A lock refusal means another deployer owns the attempt, so it is no outcome.
 */
export function parseRedeployLog(text: string): LoggedOutcome[] {
  const outcomes: LoggedOutcome[] = [];
  let at: string | null = null;
  let open: LoggedOutcome | undefined;
  for (const line of text.split("\n")) {
    at = START.exec(line)?.[1] ?? at;
    const kind = kindOf(line);
    if (open && kind === undefined && line !== "" && !CLOSES.test(line)) {
      open.text = `${open.text}\n${line}`.slice(0, REASON_MAX_CHARS);
      continue;
    }
    open = undefined;
    if (kind === undefined) continue;
    const outcome = { kind, at, text: line.replace(/^error: /, "") } satisfies LoggedOutcome;
    outcomes.push(outcome);
    if (kind === "refused") open = outcome;
  }
  return outcomes;
}

export const namesIndexLock = (reason: string): boolean => reason.includes("index.lock");

function refusalStreak(outcomes: readonly LoggedOutcome[]): number {
  let streak = 0;
  for (let index = outcomes.length - 1; index >= 0 && outcomes[index]!.kind === "refused"; index--) streak++;
  return streak;
}

function lastRefusal(outcomes: readonly LoggedOutcome[], lockNote: string | undefined): DeployHealth["lastRefusal"] {
  const last = [...outcomes].reverse().find((outcome) => outcome.kind === "refused");
  if (!last) return null;
  const note = lockNote !== undefined && namesIndexLock(last.text) ? `\n${lockNote}` : "";
  return { at: last.at, reason: `${last.text}${note}` };
}

function lagFields(lag: MainLag | string, now: number): Pick<DeployHealth, "behind" | "behindMinutes" | "lagUnknown"> {
  if (typeof lag === "string") return { behind: null, behindMinutes: null, lagUnknown: lag };
  const minutes = lag.behind > 0 && lag.oldestAt !== undefined ? Math.max(0, Math.floor((now - lag.oldestAt) / 60_000)) : 0;
  return { behind: lag.behind, behindMinutes: minutes };
}

function alarmCauses(health: Omit<DeployHealth, "alarm" | "causes">): string[] {
  const { consecutiveRefusals: refusals, behind, behindMinutes, runningSha } = health;
  const causes: string[] = [];
  if (refusals >= REFUSALS_TO_ALARM) causes.push(`service deploy refused ${refusals} times in a row; last: ${health.lastRefusal?.reason.split("\n")[0] ?? ""}`);
  if (behind !== null && behind > BEHIND_MERGES_TO_ALARM) causes.push(`serve runs ${runningSha}, ${behind} merges behind origin/main`);
  if (behindMinutes !== null && behindMinutes > BEHIND_MINUTES_TO_ALARM) causes.push(`serve has been behind origin/main for ${behindMinutes} min`);
  return causes;
}

/** Alarms on two refusals in a row, or a build more than 3 merges or 60 minutes behind origin/main; a deploy that lands clears the streak. */
export function deployHealth(input: DeployHealthInput): DeployHealth {
  const base = {
    runningSha: input.runningSha,
    ...lagFields(input.lag, input.now),
    consecutiveRefusals: refusalStreak(input.outcomes),
    lastRefusal: lastRefusal(input.outcomes, input.lockNote),
  };
  const causes = alarmCauses(base);
  return { ...base, alarm: causes.length > 0, causes };
}

/** The one message the hub seat gets when the alarm goes up. */
export const alarmMessage = (health: DeployHealth): string =>
  `titan-factory deploy alarm: ${health.causes.join("; ")}. titan-factory shepherd status shows the deploy block.`;

/** The human summary line `shepherd status` prints under its rows. */
export function deploySummary(health: DeployHealth): string {
  const behind = health.behind === null ? `behind unknown (${health.lagUnknown ?? "no probe"})` : `${health.behind} behind origin/main`;
  const state = health.alarm ? `ALARM: ${health.causes.join("; ")}` : "ok";
  return `deploy: running ${health.runningSha}, ${behind}, ${health.consecutiveRefusals} refusal(s) in a row; ${state}\n`;
}

/** The deploy block from a `/health` answer; null when serve answered none or keeps none. */
export function deployBlockOf(health: Record<string, unknown> | null): DeployHealth | null {
  const block = health?.deploy;
  if (typeof block !== "object" || block === null) return null;
  const { alarm, causes, runningSha } = block as Partial<DeployHealth>;
  return typeof alarm === "boolean" && Array.isArray(causes) && typeof runningSha === "string" ? (block as DeployHealth) : null;
}
