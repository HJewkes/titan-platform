import { z } from "zod";

/**
 * How long a seat's digest may wait: a prompt-class item (a new open gate or seat-fix item) settles `settleMs` so a burst
 * shares one message; batch-class items (finished runs, cleared items) wait up to `flushMs` or until `maxBatch` pile up.
 * The split is a conservative default until TP-1572 lists which events need judgement.
 */
export const SeatDigestPacingSchema = z.strictObject({
  settleMs: z.number().int().min(0).default(120_000),
  flushMs: z.number().int().min(0).default(1_800_000),
  maxBatch: z.number().int().positive().default(20),
});

export type DigestPacing = z.infer<typeof SeatDigestPacingSchema>;

/** The keys of what a seat has not been told yet, by class. */
export interface PendingItems {
  prompt: readonly string[];
  batch: readonly string[];
}

/** When each pending item was first seen, in epoch ms, keyed `prompt:<key>` or `batch:<key>`. */
type FirstSeen = ReadonlyMap<string, number>;

const oldestAge = (keys: readonly string[], since: FirstSeen, at: number): number => Math.max(...keys.map((key) => at - (since.get(key) ?? at)));

/** Whether a seat's digest goes now: a settled prompt item sends; with none pending, an old or full batch does. */
function paceDue(pending: PendingItems, since: FirstSeen, at: number, pacing: DigestPacing): boolean {
  const prompt = pending.prompt.map((key) => `prompt:${key}`);
  if (prompt.length > 0) return oldestAge(prompt, since, at) >= pacing.settleMs;
  const batch = pending.batch.map((key) => `batch:${key}`);
  if (batch.length === 0) return false;
  return batch.length >= pacing.maxBatch || oldestAge(batch, since, at) >= pacing.flushMs;
}

/**
 * The first-seen times paceDue reads, held per seat in memory only: an unsent item is never written to the seat's digest
 * memory, so after a restart it is still unsent and its clock starts again.
 */
export interface DigestPacer {
  due(seat: string, pending: PendingItems, now: Date): boolean;
  /** The seat was sent its digest, or has nothing pending. */
  clear(seat: string): void;
}

export function digestPacer(pacing: DigestPacing): DigestPacer {
  const seen = new Map<string, FirstSeen>();
  return {
    due: (seat, pending, now) => {
      const at = now.getTime();
      const last = seen.get(seat);
      const keys = [...pending.prompt.map((key) => `prompt:${key}`), ...pending.batch.map((key) => `batch:${key}`)];
      const since = new Map(keys.map((key) => [key, last?.get(key) ?? at]));
      seen.set(seat, since);
      return paceDue(pending, since, at, pacing);
    },
    clear: (seat) => void seen.delete(seat),
  };
}
