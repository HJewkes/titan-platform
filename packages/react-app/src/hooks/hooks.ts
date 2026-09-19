import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { CommandMap, SseMessage } from "@titan-design/rpc-protocol";
import { snapshotKey, type CommandName, type LiveStatus, type RpcError } from "@titan-design/rpc-client";
import { useRpcRuntime } from "./provider.js";

interface QueryControls {
  /** True while a call is in flight, including a refetch that keeps the previous data. */
  isFetching: boolean;
  refetch(): void;
}

/** A failed refetch keeps the last good data beside the error. */
export type QueryResult<R> = QueryControls &
  (
    | { status: "loading"; data: undefined; error: undefined }
    | { status: "success"; data: R; error: undefined }
    | { status: "error"; data: R | undefined; error: RpcError }
  );

/** Args may be left out only when the command accepts an empty object. */
export type QueryArgs<A> = Record<string, never> extends A ? [args?: A] : [args: A];

export interface InvalidateOnOptions<M extends CommandMap> {
  /** Event names that trigger a refetch; every product event when omitted. */
  events?: readonly string[];
  /** Commands to refetch; every watched query when omitted. */
  commands?: readonly CommandName<M>[];
}

export interface RpcHooks<M extends CommandMap> {
  useQuery<K extends CommandName<M>>(name: K, ...args: QueryArgs<M[K]["args"]>): QueryResult<M[K]["result"]>;
  /** Opens the provider's shared event stream while mounted and reports its status. */
  useEvents(onEvent?: (message: SseMessage) => void): LiveStatus;
  useInvalidate(): (commands?: readonly CommandName<M>[]) => void;
  /** Refetches on matching events, and after the stream reconnects, since frames sent while it was down are lost. */
  useInvalidateOn(options?: InvalidateOnOptions<M>): LiveStatus;
}

/** Binds the hooks to a product's command map; the hooks themselves are untyped underneath. */
export function createRpcHooks<M extends CommandMap>(): RpcHooks<M> {
  return { useQuery, useEvents, useInvalidate, useInvalidateOn } as unknown as RpcHooks<M>;
}

function useQuery(name: string, args?: unknown): QueryResult<unknown> {
  const { queries } = useRpcRuntime();
  const key = snapshotKey(name, args);
  const argsRef = useRef(args);
  argsRef.current = args;
  const watch = useCallback((listener: () => void) => queries.watch(name, argsRef.current, listener), [queries, key]);
  const read = useCallback(() => queries.state(key), [queries, key]);
  const state = useSyncExternalStore(watch, read, read);
  const refetch = useCallback(() => queries.refetch(key), [queries, key]);
  return useMemo(() => ({ ...state, refetch }) as QueryResult<unknown>, [state, refetch]);
}

function useEvents(onEvent?: (message: SseMessage) => void): LiveStatus {
  const { events } = useRpcRuntime();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => events.listen((message) => handler.current?.(message)), [events]);
  return useSyncExternalStore(events.watchStatus, events.status, events.status);
}

function useInvalidate(): (commands?: readonly string[]) => void {
  const { queries } = useRpcRuntime();
  return useCallback((commands?: readonly string[]) => queries.invalidate(commands), [queries]);
}

function useInvalidateOn(options: InvalidateOnOptions<CommandMap> = {}): LiveStatus {
  const invalidate = useInvalidate();
  const latest = useRef(options);
  latest.current = options;
  const status = useEvents((message) => {
    const { events: names, commands } = latest.current;
    if (!names || names.includes(message.event)) invalidate(commands);
  });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (status !== "open") return;
    if (wasOpen.current) invalidate(latest.current.commands);
    wasOpen.current = true;
  }, [status, invalidate]);
  return status;
}
