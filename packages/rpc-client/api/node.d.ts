import { D as DataSource, d as SnapshotPlan, a as Snapshot } from './snapshot.js';
import '@titan-design/rpc-protocol';

/**
 * Answers every planned call through `source` and writes one `titan-snapshot@1` file.
 * For an in-process registry, pass `{ call }` wrapping `invokeCommand`; a `liveSource`
 * exports from a running daemon instead.
 */
declare function exportSnapshot(file: string, source: Pick<DataSource, "call">, plan: SnapshotPlan): Promise<Snapshot>;

export { Snapshot, SnapshotPlan, exportSnapshot };

// ./dist/snapshot.d.ts
import { JsonEnvelope, SseMessage } from '@titan-design/rpc-protocol';

interface CallOptions {
    signal?: AbortSignal;
}
/** `connecting` covers the first dial and every reconnect; `closed` is final. */
type LiveStatus = "connecting" | "open" | "closed";
interface EventHandlers {
    /** Product broadcasts only; the reserved `ready` and `ping` frames never reach here. */
    onEvent(message: SseMessage): void;
    onStatus?(status: LiveStatus): void;
    /** Why a dial failed before `ready`: `HTTP <status>` for a refusal, else the fetch error's message. Not called for a caller's abort or a drop after `ready`. */
    onDialFailure?(reason: string): void;
}
interface Subscription {
    close(): void;
}
/**
 * Where a client's answers come from. The contract is untyped on purpose: a source moves
 * envelopes, and `createRpcClient<M>` adds the command types on top.
 */
interface DataSource {
    /** Resolves to an envelope for every outcome, failures included; rejects only when aborted. */
    call(name: string, args: unknown, options?: CallOptions): Promise<JsonEnvelope<unknown>>;
    subscribe(handlers: EventHandlers, options?: CallOptions): Subscription;
}

declare const SNAPSHOT_FORMAT = "titan-snapshot@1";
/**
 * One JSON file that answers calls without a server: recorded envelopes keyed by
 * `snapshotKey(command, args)`, and an optional dataset that a resolver answers from.
 */
interface Snapshot {
    format: typeof SNAPSHOT_FORMAT;
    /** ISO 8601 time the snapshot was taken, so a reader can say how old the data is. */
    createdAt: string;
    calls: Record<string, JsonEnvelope<unknown>>;
    /** Opaque here; its shape belongs to whichever package supplies the resolver. */
    dataset?: unknown;
}
/**
 * Answers a call from a snapshot's dataset. `args` arrive raw and unvalidated, so the
 * resolver validates them the way the daemon would. Never throws: an unknown or
 * live-only command is `EXIT.UNAVAILABLE`, bad args are `EXIT.DATAERR`.
 */
type SnapshotResolver<D = unknown> = (command: string, args: unknown, dataset: D) => JsonEnvelope<unknown> | Promise<JsonEnvelope<unknown>>;
interface SnapshotPlan {
    /** Calls to record, each answered once by the source. */
    calls?: ReadonlyArray<{
        command: string;
        args?: unknown;
    }>;
    dataset?: unknown;
    /** Defaults to now. */
    createdAt?: Date;
}
/** Records every planned call's envelope, failures included, so a replay fails the same way. */
declare function buildSnapshot(source: Pick<DataSource, "call">, plan: SnapshotPlan): Promise<Snapshot>;
/** Checks a parsed file is a `titan-snapshot@1`; throws naming the first thing wrong. */
declare function parseSnapshot(value: unknown): Snapshot;

export { type CallOptions as C, type DataSource as D, type EventHandlers as E, type LiveStatus as L, type Subscription as S, type Snapshot as a, type SnapshotResolver as b, SNAPSHOT_FORMAT as c, type SnapshotPlan as d, buildSnapshot as e, parseSnapshot as p };
