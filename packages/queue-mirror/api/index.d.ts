import { a as QueueItem, Q as QueueSource, V as VerdictInput, C as CloseOutcome, R as ResolveResult, S as SourceEvent, M as MirrorState, P as PostedItem, b as StateChange, c as MirrorLogger } from './types.js';
import { ItemInput, ItemKind, SyncBatch, AppserviceClient, TitanItem } from '@titan-design/matrix-bus';

/** A base64-like run is a secret only if it mixes digits and both cases and no path segment is a plain word. */
declare function looksSecret(run: string): boolean;
/** Section 10 decision 3: masks auth headers, key=value secrets and long hex or base64 runs. */
declare function redactPreview(text: string): {
    text: string;
    redacted: boolean;
};

/** Halves `inputPreview` and `text` until the encoded content fits, marking the item truncated. */
declare function fitItem(input: ItemInput): ItemInput;
/** Redacts before fitting, so a cut never strands the tail of a secret the patterns no longer see whole. */
declare function toItemInput(item: QueueItem): ItemInput;
/** A /sync filter that returns only the queue room's timeline, with no presence, receipts or account data. */
declare function syncFilter(roomId: string): Record<string, unknown>;

/** An in-memory QueueSource for tests; cursors are the 1-based position in its event log. */
declare class MemoryQueueSource implements QueueSource {
    readonly kinds: readonly ItemKind[];
    readonly resolutions: Array<{
        id: string;
    } & VerdictInput>;
    private readonly pending;
    private readonly log;
    private readonly waiters;
    constructor(kinds?: readonly ItemKind[]);
    add(item: QueueItem): void;
    close(id: string, outcome: CloseOutcome, label?: string): void;
    open(): Promise<QueueItem[]>;
    resolve(id: string, verdict: VerdictInput): Promise<ResolveResult>;
    /** "Now" is fixed when tail is called, not at the first next(), so nothing added in between is missed. */
    tail(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent>;
    private stream;
    private nextCursor;
    private append;
    private nextAppend;
}

interface MirrorSnapshot {
    sourceCursor?: string;
    syncToken?: string;
    posted: PostedItem[];
    applied: string[];
}
/** An in-memory MirrorState; `snapshot` and `restore` stand in for a restart in replay tests. */
declare class MemoryMirrorState implements MirrorState {
    private cursor;
    private token;
    private readonly items;
    private readonly eventIndex;
    private readonly applied;
    static restore(snapshot: MirrorSnapshot): MemoryMirrorState;
    sourceCursor(): string | undefined;
    syncToken(): string | undefined;
    bySourceId(id: string): PostedItem | undefined;
    byEventId(eventId: string): PostedItem | undefined;
    openItems(): PostedItem[];
    hasApplied(resolutionEventId: string): boolean;
    /** Applies posted before closed, so one change may post and close the same item. */
    commit(change: StateChange): void;
    snapshot(): MirrorSnapshot;
}

interface Backoff {
    initialMs: number;
    maxMs: number;
}

/** The slice of AppserviceClient the mirror drives; tests pass a fake hub. */
type MirrorBus = Pick<AppserviceClient, "send" | "syncLoop" | "messages" | "userId">;
interface MirrorOptions {
    ownerUserId: string;
    roomId: string;
    signal: AbortSignal;
    now?: () => number;
    /** Default expiry for approval_request items lacking expiresAt. */
    approvalTtlMs?: number;
    sweepIntervalMs?: number;
    syncTimeoutMs?: number;
    backoff?: Backoff;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    logger?: MirrorLogger;
}
/** Steps exposed so tests drive the mirror deterministically; runMirror only loops over them. */
interface Mirror {
    reconcile(): Promise<void>;
    applySourceEvent(event: SourceEvent): Promise<void>;
    applySyncBatch(batch: SyncBatch): Promise<void>;
    sweepExpired(): Promise<void>;
}
declare function createMirror(source: QueueSource, bus: MirrorBus, state: MirrorState, options: MirrorOptions): Mirror;

/** Runs the source tail (reconciling on each start), the sync loop and the expiry sweep until `signal` aborts. */
declare function runMirror(source: QueueSource, bus: MirrorBus, state: MirrorState, options: MirrorOptions): Promise<void>;

/** An m.replace edit of an item: a short headline and status body, with the original record in m.new_content. */
declare function encodeEdit(targetEventId: string, record: TitanItem, status: string): Record<string, unknown>;

export { type Backoff, CloseOutcome, MemoryMirrorState, MemoryQueueSource, type Mirror, type MirrorBus, MirrorLogger, type MirrorOptions, type MirrorSnapshot, MirrorState, PostedItem, QueueItem, QueueSource, ResolveResult, SourceEvent, StateChange, VerdictInput, createMirror, encodeEdit, fitItem, looksSecret, redactPreview, runMirror, syncFilter, toItemInput };

// ./dist/types.d.ts
import { Verdict, ItemKind, TitanItem } from '@titan-design/matrix-bus';

/** One pending thing a human can act on; `id` becomes TitanItem.msg_id. */
interface QueueItem {
    id: string;
    kind: ItemKind;
    machine: string;
    session: string;
    at: number;
    agentId?: string;
    toolName?: string;
    inputPreview?: string;
    recipient?: string;
    text?: string;
    /** Epoch ms; the mirror edits the item "expired" once the clock passes it. */
    expiresAt?: number;
}
type CloseOutcome = "resolved" | "cancelled" | "expired";
type SourceEvent = {
    type: "opened";
    item: QueueItem;
    cursor: string;
} | {
    type: "closed";
    id: string;
    outcome: CloseOutcome;
    label?: string;
    cursor: string;
}
/** The source lost its place (e.g. a gap too large to replay); the mirror re-reconciles against open(). */
 | {
    type: "resync";
    cursor: string;
};
interface VerdictInput {
    verdict: Verdict;
    text?: string;
    resolutionEventId: string;
    /** The Matrix user who sent the resolving event; the fold only admits the owner. */
    sender: string;
}
type ResolveResult = {
    ok: true;
} | {
    ok: false;
    reason: "closed" | "rejected";
    detail?: string;
};
interface QueueSource {
    readonly kinds: readonly ItemKind[];
    open(): Promise<QueueItem[]>;
    /** Events after `cursor` (undefined = from now); ends when `signal` aborts. */
    tail(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent>;
    resolve(id: string, verdict: VerdictInput): Promise<ResolveResult>;
}
interface PostedItem {
    sourceId: string;
    eventId: string;
    kind: ItemKind;
    /** False when the item was redacted or truncated, so no phone verdict may resolve it. */
    approvable: boolean;
    status: "open" | "closed";
    /** Epoch ms after which the sweep closes the item: the source's expiry, or the approval TTL. */
    expiresAt?: number;
    /** The record as posted; an edit repeats it in m.new_content and reads its redacted and truncated flags. */
    record: TitanItem;
}
interface StateChange {
    sourceCursor?: string;
    syncToken?: string;
    posted?: PostedItem[];
    /** Source ids. */
    closed?: string[];
    /** Resolution event ids. */
    applied?: string[];
}
/** Synchronous like hitl's GateStore: both implementations are local. `commit` is atomic. */
interface MirrorState {
    sourceCursor(): string | undefined;
    syncToken(): string | undefined;
    bySourceId(id: string): PostedItem | undefined;
    byEventId(eventId: string): PostedItem | undefined;
    openItems(): PostedItem[];
    hasApplied(resolutionEventId: string): boolean;
    commit(change: StateChange): void;
}
interface MirrorLogger {
    info(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
}

export type { CloseOutcome as C, MirrorState as M, PostedItem as P, QueueSource as Q, ResolveResult as R, SourceEvent as S, VerdictInput as V, QueueItem as a, StateChange as b, MirrorLogger as c };
