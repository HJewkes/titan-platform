import type { OwnerItem, QueueSource } from "@titan-design/owner-queue";

export interface KeepWindow {
  /** A kept read younger than this is served as is. */
  freshMs: number;
  /** Older than `freshMs` but younger than this, the kept read is served while one refresh runs behind; older, a read waits. */
  staleMs: number;
  now?: () => number;
}

interface Kept {
  items: OwnerItem[];
  at: number;
}

interface KeptRead {
  open: () => Promise<OwnerItem[]>;
  drop: () => void;
}

interface KeptState {
  kept?: Kept;
  inflight?: Promise<OwnerItem[]>;
  /** Bumped by every drop, so a read that began before a write is not kept after it. */
  generation: number;
}

/** One read at a time: callers that arrive while it runs share it. */
function refresh(state: KeptState, read: () => Promise<OwnerItem[]>, now: () => number): Promise<OwnerItem[]> {
  if (state.inflight !== undefined) return state.inflight;
  const startedAt = state.generation;
  const pending = read()
    .then((items) => {
      if (startedAt === state.generation) state.kept = { items, at: now() };
      return items;
    })
    .finally(() => {
      if (state.inflight === pending) state.inflight = undefined;
    });
  state.inflight = pending;
  return pending;
}

function keptRead(read: () => Promise<OwnerItem[]>, { freshMs, staleMs, now = Date.now }: KeepWindow): KeptRead {
  const state: KeptState = { generation: 0 };
  const open = async (): Promise<OwnerItem[]> => {
    const { kept } = state;
    if (kept === undefined) return refresh(state, read, now);
    const age = now() - kept.at;
    if (age >= staleMs) return refresh(state, read, now);
    if (age >= freshMs) refresh(state, read, now).catch(() => undefined);
    return kept.items;
  };
  const drop = (): void => {
    state.generation += 1;
    state.kept = undefined;
    state.inflight = undefined;
  };
  return { open, drop };
}

/**
 * A slow source's open items kept between reads (TP-4757). The active-work leg costs seconds on a large
 * active root while the inbox polls every few seconds, so a cold console open waited on it every time.
 * A failed read is never kept, and a resolve the source accepts drops the kept read, so the next read is live.
 */
export function keptSource(source: QueueSource, window: KeepWindow): QueueSource {
  const read = keptRead(() => source.open(), window);
  return {
    ...source,
    open: read.open,
    resolve: async (ref, answer) => {
      const result = await source.resolve(ref, answer);
      if (result.ok) read.drop();
      return result;
    },
  };
}
