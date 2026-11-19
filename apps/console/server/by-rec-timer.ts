/**
 * Runs the rounds by-rec sweep (TP-6773) inside the console daemon, hourly, so no timer unit is needed. The first pass
 * waits a few minutes after start, so a daemon that restarts often still sweeps and a short-lived one (a test's) never
 * does. A skip is logged once per round and reason for the daemon's life; a skip that only waits is never logged.
 */
import type { Logger } from "@titan-design/daemon";
import { sweepByRecRounds, type ByRecSweepReport } from "./by-rec-rounds.js";
import type { SubmitPipeline } from "./rounds-submit.js";

const MINUTE_MS = 60_000;
export const BY_REC_FIRST_AFTER_MS = 5 * MINUTE_MS;
export const BY_REC_EVERY_MS = 60 * MINUTE_MS;

interface TimerOptions {
  dir: string;
  stateDir: string;
  submit: SubmitPipeline;
  logger: Logger;
  firstAfterMs?: number;
  everyMs?: number;
}

function reportTo(logger: Logger, logged: Set<string>, { mode, problem, outcomes }: ByRecSweepReport): void {
  if (problem !== undefined && !logged.has(problem)) logger.warn({ mode }, problem);
  if (problem !== undefined) logged.add(problem);
  for (const { roundId, result, reason, waiting } of outcomes) {
    const key = `${roundId}\n${result}\n${reason ?? ""}`;
    if (waiting === true || logged.has(key)) continue;
    logged.add(key);
    const log = result === "failed" ? logger.warn : logger.info;
    log.call(logger, { roundId, mode, result, ...(reason !== undefined && { reason }) }, "auto-by-rec round");
  }
}

export function startByRecRounds({ dir, stateDir, submit, logger, firstAfterMs = BY_REC_FIRST_AFTER_MS, everyMs = BY_REC_EVERY_MS }: TimerOptions): { close: () => void } {
  const logged = new Set<string>();
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      reportTo(logger, logged, await sweepByRecRounds({ dir, stateDir, submit, now: new Date() }));
    } catch (error) {
      logger.error({ error }, "auto-by-rec round sweep failed");
    } finally {
      running = false;
    }
  };
  let every: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void pass();
    every = setInterval(() => void pass(), everyMs);
    every.unref();
  }, firstAfterMs);
  first.unref();
  return { close: () => (clearTimeout(first), clearInterval(every)) };
}
