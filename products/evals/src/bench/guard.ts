import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { loadavg } from "node:os";
import { z } from "zod";

const GUARD_LIMITS = { load5: 40, tmpPct: 65, jobsDiskPct: 92, sevenDayPct: 92, accountEvery: 10, pauseMs: 60_000 } as const;

/** Each reader is injected so tests drive the thresholds without touching the machine. */
export interface GuardReaders {
  load5(): number;
  diskUsedPct(path: string): number;
  /** The account's seven-day used percentage; throws when the status cannot be read. */
  sevenDayPct(): Promise<number>;
}

interface GuardOptions {
  readers: GuardReaders;
  jobsDir: string;
  tmpDir?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type GuardDecision = { go: true } | { go: false; reason: string };

/** Why dispatch should wait right now, or undefined when the machine has headroom. */
export function pauseReason(readers: GuardReaders, jobsDir: string, tmpDir = "/tmp"): string | undefined {
  const load5 = readers.load5();
  if (load5 > GUARD_LIMITS.load5) return `load5 ${load5} > ${GUARD_LIMITS.load5}`;
  const tmp = readers.diskUsedPct(tmpDir);
  if (tmp > GUARD_LIMITS.tmpPct) return `${tmpDir} ${tmp.toFixed(1)}% > ${GUARD_LIMITS.tmpPct}%`;
  const jobs = readers.diskUsedPct(jobsDir);
  if (jobs > GUARD_LIMITS.jobsDiskPct) return `jobs disk ${jobs.toFixed(1)}% > ${GUARD_LIMITS.jobsDiskPct}%`;
  return undefined;
}

/** An unreadable account status stops the run: dispatching blind could spend past the cap. */
async function stopReason(readers: GuardReaders): Promise<string | undefined> {
  try {
    const used = await readers.sevenDayPct();
    return used >= GUARD_LIMITS.sevenDayPct ? `account seven_day ${used}% >= ${GUARD_LIMITS.sevenDayPct}%` : undefined;
  } catch (error) {
    return `account status unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Called before every dispatch: waits out machine pressure, and every 10th call checks the account cap. */
export function createGuard(options: GuardOptions): () => Promise<GuardDecision> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let dispatches = 0;
  return async () => {
    if (dispatches++ % GUARD_LIMITS.accountEvery === 0) {
      const reason = await stopReason(options.readers);
      if (reason !== undefined) return { go: false, reason };
    }
    const pause = () => pauseReason(options.readers, options.jobsDir, options.tmpDir);
    for (let reason = pause(); reason !== undefined; reason = pause()) {
      options.log?.(`guard: pausing, ${reason}`);
      await sleep(GUARD_LIMITS.pauseMs);
    }
    return { go: true };
  };
}

function diskUsedPct(path: string): number {
  const stats = statfsSync(path);
  const used = stats.blocks - stats.bfree;
  return (used / (used + stats.bavail)) * 100;
}

const AccountStatus = z.looseObject({
  profiles: z.array(z.looseObject({ label: z.string(), usage: z.looseObject({ rate_limits: z.looseObject({ seven_day: z.looseObject({ used_percentage: z.number() }).optional() }) }).optional() })),
});

/** `anthropic-account status --json` exits non-zero when any profile's login is refused, so stdout is read regardless. */
function readSevenDay(profile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("anthropic-account", ["status", "--json"], { timeout: 30_000 }, (_error, stdout) => {
      try {
        const status = AccountStatus.parse(JSON.parse(stdout));
        const used = status.profiles.find((entry) => entry.label === profile)?.usage?.rate_limits.seven_day?.used_percentage;
        if (used === undefined) throw new Error(`no seven_day usage for profile ${profile}`);
        resolve(used);
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    });
  });
}

export function machineReaders(accountProfile: string): GuardReaders {
  return { load5: () => loadavg()[1] ?? 0, diskUsedPct, sevenDayPct: () => readSevenDay(accountProfile) };
}
