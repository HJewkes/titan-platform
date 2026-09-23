import type { MirrorState, PostedItem, StateChange } from "./types.js";

export interface MirrorSnapshot {
  sourceCursor?: string;
  syncToken?: string;
  posted: PostedItem[];
  applied: string[];
}

/** An in-memory MirrorState; `snapshot` and `restore` stand in for a restart in replay tests. */
export class MemoryMirrorState implements MirrorState {
  private cursor: string | undefined;
  private token: string | undefined;
  private readonly items = new Map<string, PostedItem>();
  private readonly eventIndex = new Map<string, string>();
  private readonly applied = new Set<string>();

  static restore(snapshot: MirrorSnapshot): MemoryMirrorState {
    const state = new MemoryMirrorState();
    state.commit({ ...snapshot, posted: snapshot.posted.map((item) => ({ ...item })) });
    return state;
  }

  sourceCursor(): string | undefined {
    return this.cursor;
  }

  syncToken(): string | undefined {
    return this.token;
  }

  bySourceId(id: string): PostedItem | undefined {
    return this.items.get(id);
  }

  byEventId(eventId: string): PostedItem | undefined {
    const sourceId = this.eventIndex.get(eventId);
    return sourceId === undefined ? undefined : this.items.get(sourceId);
  }

  openItems(): PostedItem[] {
    return [...this.items.values()].filter((item) => item.status === "open");
  }

  hasApplied(resolutionEventId: string): boolean {
    return this.applied.has(resolutionEventId);
  }

  /** Applies posted before closed, so one change may post and close the same item. */
  commit(change: StateChange): void {
    for (const item of change.posted ?? []) {
      this.items.set(item.sourceId, { ...item });
      this.eventIndex.set(item.eventId, item.sourceId);
    }
    for (const id of change.closed ?? []) {
      const item = this.items.get(id);
      if (item) item.status = "closed";
    }
    for (const id of change.applied ?? []) this.applied.add(id);
    if (change.sourceCursor !== undefined) this.cursor = change.sourceCursor;
    if (change.syncToken !== undefined) this.token = change.syncToken;
  }

  snapshot(): MirrorSnapshot {
    return {
      sourceCursor: this.cursor,
      syncToken: this.token,
      posted: [...this.items.values()].map((item) => ({ ...item })),
      applied: [...this.applied],
    };
  }
}
