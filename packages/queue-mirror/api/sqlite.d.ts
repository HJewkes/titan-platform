import { Db, Migration } from '@titan-design/store-sqlite';
import { M as MirrorState, P as PostedItem, b as StateChange } from './types.js';
import '@titan-design/matrix-bus';

declare const DEFAULT_MIRROR_TABLE_PREFIX = "queue_mirror";
declare function mirrorTableDdl(prefix?: string): string;
/** Drop into the product's own `runMigrations` list so queue-mirror shares one database with its domain tables. */
declare function mirrorMigration(version: number, prefix?: string): Migration;
interface SqliteMirrorStateOptions {
    tablePrefix?: string;
    /** Run `mirrorMigration` on construction. Off when the product owns its migration list. */
    migrate?: boolean;
}
/**
 * Durable mirror state. `commit` runs every write in one transaction, so a
 * failure partway (e.g. a duplicate event id) leaves no partial rows behind.
 */
declare class SqliteMirrorState implements MirrorState {
    private readonly db;
    private readonly itemTable;
    private readonly appliedTable;
    private readonly cursorTable;
    private readonly applyChange;
    constructor(db: Db, options?: SqliteMirrorStateOptions);
    sourceCursor(): string | undefined;
    syncToken(): string | undefined;
    bySourceId(id: string): PostedItem | undefined;
    byEventId(eventId: string): PostedItem | undefined;
    openItems(): PostedItem[];
    hasApplied(resolutionEventId: string): boolean;
    commit(change: StateChange): void;
    /** Applies posted before closed, so one change may post and close the same item; matches MemoryMirrorState. */
    private applyChangeUnsafe;
    private readCursor;
    private upsertCursor;
    private insertItem;
    private closeItem;
    private markApplied;
}

export { DEFAULT_MIRROR_TABLE_PREFIX, SqliteMirrorState, type SqliteMirrorStateOptions, mirrorMigration, mirrorTableDdl };

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
