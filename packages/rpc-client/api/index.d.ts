import { CommandMap, SseMessage } from '@titan-design/rpc-protocol';
import { C as CallOptions, E as EventHandlers, S as Subscription, D as DataSource, a as Snapshot, b as SnapshotResolver } from './snapshot.js';
export { L as LiveStatus, c as SNAPSHOT_FORMAT, d as SnapshotPlan, e as buildSnapshot, p as parseSnapshot } from './snapshot.js';

/** A failed call: the envelope's message plus its sysexits `code`, and the command that failed. */
declare class RpcError extends Error {
    readonly command: string;
    readonly code: number;
    constructor(command: string, message: string, code: number);
}
/** Args may be left out only when the command accepts an empty object. */
type CallArgs<A> = Record<string, never> extends A ? [args?: A, options?: CallOptions] : [args: A, options?: CallOptions];
type DeclaredNames<M> = keyof {
    [K in keyof M as string extends K ? never : K]: M[K];
} & string;
/** The map's declared names; an `interface extends CommandMap` would otherwise admit any string. */
type CommandName<M extends CommandMap> = [DeclaredNames<M>] extends [never] ? keyof M & string : DeclaredNames<M>;
interface RpcClient<M extends CommandMap> {
    /** Resolves to the command's result; rejects with `RpcError` on a failure envelope. */
    call<K extends CommandName<M>>(name: K, ...rest: CallArgs<M[K]["args"]>): Promise<M[K]["result"]>;
    subscribe(handlers: EventHandlers, options?: CallOptions): Subscription;
    readonly source: DataSource;
}
declare function createRpcClient<M extends CommandMap>(source: DataSource): RpcClient<M>;

interface LiveSourceOptions {
    /** Daemon origin such as `http://127.0.0.1:7400`; empty means the page's own origin. */
    origin?: string;
    /** Defaults to the global `fetch`; inject one to add headers or run under a test double. */
    fetch?: typeof fetch;
    /** First redial delay after a dropped event stream. Defaults to 500. */
    reconnectDelayMs?: number;
    /** Cap on the doubling redial delay. Defaults to 10000. */
    maxReconnectDelayMs?: number;
}
/** A running daemon: `POST /rpc/<name>` for calls and `/events` for pushes. */
declare function liveSource(options?: LiveSourceOptions): DataSource;

interface StaticSourceOptions {
    snapshot: Snapshot;
    /** Answers calls the snapshot did not record, from `snapshot.dataset`. */
    resolve?: SnapshotResolver;
}
/** No server: recorded answers first, then the resolver, then `EXIT.UNAVAILABLE`. */
declare function staticSource({ snapshot, resolve }: StaticSourceOptions): DataSource;

/**
 * The args exactly as a daemon would receive them: JSON round-tripped, with no args,
 * `undefined`, and `null` all meaning `{}` as they do in `POST /rpc/:name`.
 */
declare function wireArgs(args: unknown): unknown;
/** The wire args as JSON with every object's keys sorted, so equal args always print the same text. */
declare function canonicalArgs(args: unknown): string;
/** The lookup key for one call in a snapshot: `["<command>",<canonical args>]`. */
declare function snapshotKey(command: string, args: unknown): string;

/**
 * Incremental parser for `text/event-stream`. Feed it decoded text in any chunking; it
 * returns the frames completed so far. `id`, `retry`, and comment lines are ignored.
 */
declare function createSseParser(): (chunk: string) => SseMessage[];

export { type CallArgs, CallOptions, type CommandName, DataSource, EventHandlers, type LiveSourceOptions, type RpcClient, RpcError, Snapshot, SnapshotResolver, type StaticSourceOptions, Subscription, canonicalArgs, createRpcClient, createSseParser, liveSource, snapshotKey, staticSource, wireArgs };

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
