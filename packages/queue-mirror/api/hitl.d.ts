import { GateRecord, GateResolver, GateStore } from '@titan-design/hitl';
import { V as VerdictInput, Q as QueueSource } from './types.js';
import '@titan-design/matrix-bus';

type GateKind = "approval_request" | "question";
type GateAction = {
    resolve: unknown;
} | {
    cancel: string;
};
interface HitlSourceOptions {
    /** TitanItem headline fields. */
    machine: string;
    session: string;
    /** hitl has no change feed, so tail polls listPending at this interval. */
    pollMs?: number;
    kindOf?: (gate: GateRecord) => GateKind;
    toPayload?: (gate: GateRecord, verdict: VerdictInput) => GateAction;
    /** Who the store records as resolving the gate; defaults to the owner over Matrix. */
    resolverOf?: (gate: GateRecord, verdict: VerdictInput) => GateResolver;
}
/** allow and approve resolve {approved: true}; an answer resolves its text; deny and dismiss cancel. */
declare function defaultGatePayload(_gate: GateRecord, { verdict, text }: VerdictInput): GateAction;
/** The reacting sender, which the mirror's fold has already checked is the owner. */
declare function defaultGateResolver(_gate: GateRecord, { sender, resolutionEventId }: VerdictInput): GateResolver;
/** A QueueSource over a hitl GateStore: pending gates become approval_request or question items. */
declare function hitlQueueSource(store: GateStore, options: HitlSourceOptions): QueueSource;

export { type GateAction, type HitlSourceOptions, defaultGatePayload, defaultGateResolver, hitlQueueSource };

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
