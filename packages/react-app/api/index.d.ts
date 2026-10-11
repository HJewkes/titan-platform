import { ReactNode } from 'react';
import { DataSource, CommandName, RpcError, LiveStatus, SnapshotResolver, Snapshot } from '@titan-design/rpc-client';
import { CommandMap, SseMessage } from '@titan-design/rpc-protocol';

type QueryStatus = "loading" | "success" | "error";

interface RpcProviderProps {
    /** `liveSource(...)` against a daemon, or `staticSource(...)` over a snapshot; components cannot tell which. */
    source: DataSource;
    children?: ReactNode;
}
/** Holds the query cache and the shared event stream for everything below it. */
declare function RpcProvider({ source, children }: RpcProviderProps): ReactNode;

interface QueryControls {
    /** True while a call is in flight, including a refetch that keeps the previous data. */
    isFetching: boolean;
    refetch(): void;
}
/** A failed refetch keeps the last good data beside the error. */
type QueryResult<R> = QueryControls & ({
    status: "loading";
    data: undefined;
    error: undefined;
} | {
    status: "success";
    data: R;
    error: undefined;
} | {
    status: "error";
    data: R | undefined;
    error: RpcError;
});
/** Args may be left out only when the command accepts an empty object. */
type QueryArgs<A> = Record<string, never> extends A ? [args?: A] : [args: A];
interface InvalidateOnOptions<M extends CommandMap> {
    /** Event names that trigger a refetch; every product event when omitted. */
    events?: readonly string[];
    /** Commands to refetch; every watched query when omitted. */
    commands?: readonly CommandName<M>[];
}
interface RpcHooks<M extends CommandMap> {
    useQuery<K extends CommandName<M>>(name: K, ...args: QueryArgs<M[K]["args"]>): QueryResult<M[K]["result"]>;
    /** Opens the provider's shared event stream while mounted and reports its status. */
    useEvents(onEvent?: (message: SseMessage) => void): LiveStatus;
    useInvalidate(): (commands?: readonly CommandName<M>[]) => void;
    /** Refetches on matching events, and after the stream reconnects, since frames sent while it was down are lost. */
    useInvalidateOn(options?: InvalidateOnOptions<M>): LiveStatus;
}
/** Binds the hooks to a product's command map; the hooks themselves are untyped underneath. */
declare function createRpcHooks<M extends CommandMap>(): RpcHooks<M>;

/** The element an exported page carries its snapshot in. */
declare const SNAPSHOT_ELEMENT_ID = "titan-snapshot";
/**
 * Writes a snapshot into a built page so it opens from disk with no server. Replaces any
 * snapshot already there. Pure string work, so an exporter can run it in Node.
 */
declare function embedSnapshot(html: string, snapshot: Snapshot): string;
/** The snapshot an exported page carries, or `undefined` for a page a daemon serves. */
declare function readEmbeddedSnapshot(doc?: Document): Snapshot | undefined;
interface PageSourceOptions {
    doc?: Document;
    /** Daemon origin for the live case; empty means the page's own origin. */
    origin?: string;
    /** Answers static calls the snapshot did not record. */
    resolve?: SnapshotResolver;
}
/** A static source over the embedded snapshot when the page has one, otherwise a live one. */
declare function pageDataSource(options?: PageSourceOptions): DataSource;

export { type InvalidateOnOptions, type PageSourceOptions, type QueryArgs, type QueryResult, type QueryStatus, type RpcHooks, RpcProvider, type RpcProviderProps, SNAPSHOT_ELEMENT_ID, createRpcHooks, embedSnapshot, pageDataSource, readEmbeddedSnapshot };
