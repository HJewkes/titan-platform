import { alarmMessage, deployHealth, namesIndexLock, parseRedeployLog, type DeployHealth, type MainLag } from "./deploy-health.js";
import { describeIndexLock, type IndexLock } from "./stale-lock.js";

export const DEPLOY_WATCH_MS = 5 * 60_000;

/** What the watch reads and who it tells; tests pass fakes, so none reaches git, gh or agent-chat. */
export interface DeployWatchPorts {
  /** The tail of redeploy.log, or undefined before the first redeploy. */
  readLog: () => string | undefined;
  runningSha: () => string;
  lag: () => Promise<MainLag | string>;
  indexLock: () => Promise<IndexLock>;
  /** Absent means no hub seat is configured, so the alarm shows only in status. */
  notify?: (text: string) => Promise<void>;
  now: () => number;
}

/** Whether the hub seat was told about the alarm that is up now. */
type AlarmNotice = { sent: string } | { failed: string } | { skipped: string };

type DeployStatus = DeployHealth & { notice: AlarmNotice | null };

export interface DeployWatch {
  /** Re-reads every source, then tells the hub seat once when the alarm goes up. */
  tick(): Promise<void>;
  /** The block from the last tick; null before the first. */
  status(): DeployStatus | null;
}

async function lockNote(ports: DeployWatchPorts, outcomes: ReturnType<typeof parseRedeployLog>): Promise<string | undefined> {
  const last = [...outcomes].reverse().find((outcome) => outcome.kind === "refused");
  return last && namesIndexLock(last.text) ? describeIndexLock(await ports.indexLock()) : undefined;
}

async function readDeployHealth(ports: DeployWatchPorts): Promise<DeployHealth> {
  const outcomes = parseRedeployLog(ports.readLog() ?? "");
  const [lag, note] = await Promise.all([ports.lag(), lockNote(ports, outcomes)]);
  return deployHealth({ outcomes, runningSha: ports.runningSha(), lag, now: ports.now(), ...(note !== undefined && { lockNote: note }) });
}

async function notice(ports: DeployWatchPorts, health: DeployHealth): Promise<AlarmNotice> {
  if (!ports.notify) return { skipped: "no hub seat is configured" };
  try {
    await ports.notify(alarmMessage(health));
    return { sent: new Date(ports.now()).toISOString() };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/** One notice per alarm: a sent notice holds until the alarm clears, and a failed one is retried on the next tick. */
export function deployWatch(ports: DeployWatchPorts): DeployWatch {
  let current: DeployStatus | null = null;
  const tick = async (): Promise<void> => {
    const health = await readDeployHealth(ports);
    const held = current?.alarm === true && current.notice !== null && !("failed" in current.notice) ? current.notice : null;
    current = { ...health, notice: health.alarm ? (held ?? (await notice(ports, health))) : null };
  };
  return { tick, status: () => current };
}
