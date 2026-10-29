import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { DataSource } from "@titan-design/rpc-client";
import { createEventBus, type EventBus } from "./event-bus.js";
import { createQueryStore, type QueryStore } from "./query-store.js";

export interface RpcRuntime {
  queries: QueryStore;
  events: EventBus;
}

const RpcContext = createContext<RpcRuntime | null>(null);

export interface RpcProviderProps {
  /** `liveSource(...)` against a daemon, or `staticSource(...)` over a snapshot; components cannot tell which. */
  source: DataSource;
  /** How long a query's result outlives its last watcher, so navigating back shows it at once; default 0. */
  gcMs?: number;
  children?: ReactNode;
}

/** Holds the query cache and the shared event stream for everything below it. */
export function RpcProvider({ source, gcMs, children }: RpcProviderProps): ReactNode {
  const runtime = useMemo<RpcRuntime>(() => ({ queries: createQueryStore(source, { gcMs }), events: createEventBus(source) }), [source, gcMs]);
  return createElement(RpcContext.Provider, { value: runtime }, children);
}

export function useRpcRuntime(): RpcRuntime {
  const runtime = useContext(RpcContext);
  if (!runtime) throw new Error("@titan-design/react-app hooks must be used inside <RpcProvider>");
  return runtime;
}
