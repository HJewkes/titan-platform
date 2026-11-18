/**
 * Keeps the precedent ledger fresh while the daemon runs (TP-6218).
 *
 * Without it the ledger only refreshes when someone runs `precedent extract` by
 * hand, so served decisions go stale. One pass shortly after start, then one per
 * interval; passes never overlap and never throw into the daemon.
 */
import type { Logger } from '@titan-design/daemon';
import { extractPrecedents } from '../decider/extract.js';
import { getActiveRoot } from '../utils/paths.js';

interface PrecedentExtractResult {
  sources: ReadonlyArray<{ source: string; written: number; errors: readonly string[] }>;
}

export type PrecedentExtract = () => Promise<PrecedentExtractResult>;

interface PrecedentWatchOptions {
  extract?: PrecedentExtract;
  /** Overrides `AW_PRECEDENT_EXTRACT_MS`; 0 turns the watcher off. */
  intervalMs?: number;
  startDelayMs?: number;
}

interface PrecedentWatcher {
  close(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const DEFAULT_START_DELAY_MS = 5_000;

function resolveIntervalMs(override: number | undefined): number {
  if (override !== undefined) return override;
  const raw = process.env.AW_PRECEDENT_EXTRACT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_INTERVAL_MS;
}

/** One pass; failures are logged, never thrown. */
async function runPass(log: Logger, extract: PrecedentExtract): Promise<void> {
  try {
    const result = await extract();
    log.info(
      {
        sources: result.sources.map((s) => ({
          source: s.source,
          added: s.written,
          errors: s.errors.length,
        })),
      },
      'precedent extract pass finished',
    );
  } catch (err) {
    log.error({ err }, 'precedent extract pass failed');
  }
}

/** Returns null when the interval is 0 (off). */
export function startPrecedentWatch(
  log: Logger,
  options: PrecedentWatchOptions = {},
): PrecedentWatcher | null {
  const intervalMs = resolveIntervalMs(options.intervalMs);
  if (intervalMs <= 0) return null;
  const extract = options.extract ?? (() => extractPrecedents({ activeRoot: getActiveRoot() }));

  let running: Promise<void> | null = null;
  let closed = false;

  const tick = (): void => {
    if (closed || running) return;
    running = runPass(log, extract).finally(() => {
      running = null;
    });
  };

  const first = setTimeout(tick, options.startDelayMs ?? DEFAULT_START_DELAY_MS);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();

  return {
    async close(): Promise<void> {
      closed = true;
      clearTimeout(first);
      clearInterval(timer);
      await running;
    },
  };
}
