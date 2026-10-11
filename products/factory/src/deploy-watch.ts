import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import { alarmMessage, deployHealth, lastRefused, namesIndexLock, parseRedeployLog, type DeployHealth } from "./deploy-health.js";
import { describeIndexLock, type IndexLock } from "./stale-lock.js";

export const DEPLOY_WATCH_MS = 5 * 60_000;

/** How loudly a standing alarm repeats itself; the defaults are the shepherd.deployAlarm config's. */
interface DeployAlarmPolicy {
  /** Ticks a sent notice holds before the hub seat is told again. */
  renotifyTicks: number;
  /** Minutes the alarm stands before it files an owner-queue item. */
  escalateAfterMinutes: number;
}

const DEFAULT_DEPLOY_ALARM_POLICY: DeployAlarmPolicy = { renotifyTicks: 6, escalateAfterMinutes: 30 };

/** What the watch reads and who it tells; tests pass fakes, so none reaches git, gh, agent-chat or the owner inbox. */
export interface DeployWatchPorts {
  /** The tail of redeploy.log, or undefined before the first redeploy. */
  readLog: () => string | undefined;
  runningSha: () => string;
  indexLock: () => Promise<IndexLock>;
  /** Absent means no hub seat is configured, so only status and the owner queue carry the alarm. */
  notify?: (text: string) => Promise<void>;
  /** Files an owner-queue item; absent means a standing alarm never leaves status and the hub seat. */
  escalate?: (deposit: OwnerItemDeposit) => Promise<void>;
  policy?: Partial<DeployAlarmPolicy>;
  now: () => number;
}

/** Whether the hub seat was told about the alarm that is up now. */
type AlarmNotice = { sent: string } | { failed: string } | { skipped: string };

/** Whether the owner queue holds an item for the alarm that is up now. */
type AlarmEscalation = { deposited: string } | { failed: string };

type DeployStatus = DeployHealth & { notice: AlarmNotice | null; escalation: AlarmEscalation | null };

export interface DeployWatch {
  /** Re-reads every source, then tells the hub seat and, past the bound, the owner queue about a standing alarm. */
  tick(): Promise<void>;
  /** The block from the last tick; null before the first. */
  status(): DeployStatus | null;
  /** What serve logs at start when the alarm has no seat to reach. */
  startupWarning?: string;
}

/** The alarm that is up: when this watch first saw it, and how many ticks the last sent notice has held. */
interface Standing {
  raisedAt: number;
  ticksSinceNotice: number;
  notice: AlarmNotice;
  escalation: AlarmEscalation | null;
}

const NO_HUB_SEAT = "no hub seat is configured";
const STATUS_COMMAND = "titan-factory shepherd status --json --deploy";
const SUMMARY_MAX = 280;

async function lockNote(ports: DeployWatchPorts, entries: ReturnType<typeof parseRedeployLog>): Promise<string | undefined> {
  const last = lastRefused(entries);
  return last && namesIndexLock(last.text) ? describeIndexLock(await ports.indexLock()) : undefined;
}

async function readDeployHealth(ports: DeployWatchPorts): Promise<DeployHealth> {
  const entries = parseRedeployLog(ports.readLog() ?? "");
  const note = await lockNote(ports, entries);
  return deployHealth({ entries, runningSha: ports.runningSha(), now: ports.now(), ...(note !== undefined && { lockNote: note }) });
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function notice(ports: DeployWatchPorts, health: DeployHealth): Promise<AlarmNotice> {
  if (!ports.notify) return { skipped: NO_HUB_SEAT };
  try {
    await ports.notify(alarmMessage(health));
    return { sent: new Date(ports.now()).toISOString() };
  } catch (error) {
    return { failed: failure(error) };
  }
}

const hubSeatNote = (told: AlarmNotice): string =>
  "sent" in told ? `The hub seat was told at ${told.sent}.` : "skipped" in told ? `The hub seat was not told: ${told.skipped}.` : `Telling the hub seat failed: ${told.failed}.`;

/** One item per running build: its depositId repeats across serve restarts, so writeDeposit files it once. */
function alarmDeposit(health: DeployHealth, minutes: number, told: AlarmNotice): OwnerItemDeposit {
  const summary = `titan-factory deploys stalled for ${minutes} min: ${health.causes.join("; ")}`.replace(/\s+/g, " ");
  return {
    depositId: `deploy-alarm-${health.runningSha}`,
    asker: "titan-factory",
    kind: "do",
    door: "two-way",
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    context: `${alarmMessage(health)} ${hubSeatNote(told)} Merged work is not live until a deploy lands.`,
    command: STATUS_COMMAND,
    keys: ["deploy-alarm"],
  };
}

async function escalation(ports: DeployWatchPorts, health: DeployHealth, standing: Standing, policy: DeployAlarmPolicy): Promise<AlarmEscalation | null> {
  if (standing.escalation && "deposited" in standing.escalation) return standing.escalation;
  const minutes = Math.floor((ports.now() - standing.raisedAt) / 60_000);
  if (!ports.escalate || minutes < policy.escalateAfterMinutes) return null;
  try {
    await ports.escalate(alarmDeposit(health, minutes, standing.notice));
    return { deposited: new Date(ports.now()).toISOString() };
  } catch (error) {
    return { failed: failure(error) };
  }
}

/** A sent notice holds for `renotifyTicks` ticks, a skipped one for the alarm's life, and a failed one is retried on the next tick. */
async function nextNotice(ports: DeployWatchPorts, health: DeployHealth, held: Standing | null, policy: DeployAlarmPolicy): Promise<Pick<Standing, "notice" | "ticksSinceNotice">> {
  const ticksSinceNotice = (held?.ticksSinceNotice ?? 0) + 1;
  const holds = held !== null && ("skipped" in held.notice || ("sent" in held.notice && ticksSinceNotice < policy.renotifyTicks));
  return holds ? { notice: held.notice, ticksSinceNotice } : { notice: await notice(ports, health), ticksSinceNotice: 0 };
}

async function nextStanding(ports: DeployWatchPorts, health: DeployHealth, held: Standing | null, policy: DeployAlarmPolicy): Promise<Standing> {
  const told = await nextNotice(ports, health, held, policy);
  const standing: Standing = { raisedAt: held?.raisedAt ?? ports.now(), ...told, escalation: held?.escalation ?? null };
  return { ...standing, escalation: await escalation(ports, health, standing, policy) };
}

const startupWarning = (policy: DeployAlarmPolicy): string =>
  `shepherd.hubSeat is not set: a deploy alarm reaches no seat; it shows in status and goes to the owner queue after ${policy.escalateAfterMinutes} min`;

export function deployWatch(ports: DeployWatchPorts): DeployWatch {
  const policy = { ...DEFAULT_DEPLOY_ALARM_POLICY, ...ports.policy };
  let current: DeployStatus | null = null;
  let standing: Standing | null = null;
  const tick = async (): Promise<void> => {
    const health = await readDeployHealth(ports);
    standing = health.alarm ? await nextStanding(ports, health, standing, policy) : null;
    current = { ...health, notice: standing?.notice ?? null, escalation: standing?.escalation ?? null };
  };
  return { tick, status: () => current, ...(!ports.notify && { startupWarning: startupWarning(policy) }) };
}
