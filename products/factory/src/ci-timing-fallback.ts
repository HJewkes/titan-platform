import type { Logger } from "@titan-design/daemon";
import { runCommand, type CommandResult } from "./run-command.js";
import { startSweep, type Sweep } from "./sweep.js";

/** GitHub's schedule can start the run hours late; a late run was seen at 14:13Z, so the fallback waits this far past 14:00Z before calling a missing run dropped. */
const CI_TIMING_DEADLINE_MINUTE_UTC = 14 * 60 + 30;
const CI_TIMING_FALLBACK_MS = 10 * 60_000;
const WORKFLOW_FILE = "ci-timing.yml";

export interface CiTimingFallbackPorts {
  repo: string;
  /** Whether the workflow has any run created on the UTC day `day` (YYYY-MM-DD). */
  hasRunOn: (day: string) => Promise<boolean>;
  /** Starts one workflow_dispatch run through the gh-write path. */
  dispatch: () => Promise<void>;
  now?: () => number;
}

/** Pure: dispatch only once the deadline has passed, no run exists for the day, and none was dispatched for it already. */
export function shouldDispatchCiTiming(input: { now: Date; runExists: boolean; dispatchedDay: string | undefined }): boolean {
  if (beforeDeadline(input.now)) return false;
  if (input.runExists) return false;
  return input.dispatchedDay !== utcDay(input.now);
}

const beforeDeadline = (at: Date): boolean => at.getUTCHours() * 60 + at.getUTCMinutes() < CI_TIMING_DEADLINE_MINUTE_UTC;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The memo lives in the closure: a restart that loses it still finds the dispatched run through `hasRunOn`. */
export function ciTimingFallbackTick(ports: CiTimingFallbackPorts, log: Logger): () => Promise<void> {
  let dispatchedDay: string | undefined;
  return async () => {
    const now = new Date((ports.now ?? Date.now)());
    const day = utcDay(now);
    if (beforeDeadline(now) || dispatchedDay === day) return;
    const runExists = await ports.hasRunOn(day);
    if (!shouldDispatchCiTiming({ now, runExists, dispatchedDay })) return;
    await ports.dispatch();
    dispatchedDay = day;
    log.info({ repo: ports.repo, day }, "dispatched the CI timing workflow: GitHub's schedule did not start one");
  };
}

export function startCiTimingFallback(ports: CiTimingFallbackPorts | undefined, log: Logger): Sweep | undefined {
  if (ports === undefined) return undefined;
  const sweep = startSweep(ciTimingFallbackTick(ports, log), CI_TIMING_FALLBACK_MS, "CI timing fallback", log);
  void sweep.tick();
  return sweep;
}

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

/** Reads through plain gh; the write goes through `agent-chat gh-write`, because the gh shim refuses `gh workflow run`. */
export function ghCiTimingPorts(repo: string, run: Run = runCommand): CiTimingFallbackPorts {
  return {
    repo,
    hasRunOn: async (day) => {
      const listed = await run("gh", ["run", "list", "--repo", repo, "--workflow", WORKFLOW_FILE, "--created", day, "--json", "databaseId", "--jq", "length"]);
      if (listed?.code !== 0) throw new Error(`could not list ${WORKFLOW_FILE} runs: ${listed?.stderr.trim() ?? "gh is not on PATH"}`);
      return Number(listed.stdout.trim()) > 0;
    },
    dispatch: async () => {
      const done = await run("agent-chat", ["gh-write", "--", "workflow", "run", WORKFLOW_FILE, "--repo", repo]);
      if (done?.code !== 0) throw new Error(`could not dispatch ${WORKFLOW_FILE}: ${done?.stderr.trim() ?? "agent-chat is not on PATH"}`);
    },
  };
}
