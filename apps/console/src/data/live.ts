import { useCallback, useEffect, useRef } from "react";
import type { CommandName } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RelaySource } from "../../server/events-relay.js";
import { useEvents, useInvalidate } from "./rpc.js";

/** The reads each relayed source can change; a broker message never refetches active-work's reads. */
const RELAY_INVALIDATES = {
  "active-work": ["work.portfolio", "work.initiative", "work.tasks", "work.task", "graph.ego"],
  "agent-chat": ["agents.roster", "agents.graph", "agents.messages", "agents.queue"],
} as const satisfies Record<RelaySource, readonly CommandName<ConsoleCommands>[]>;

const ALL_RELAYED_READS = [...RELAY_INVALIDATES["active-work"], ...RELAY_INVALIDATES["agent-chat"]];

/** A burst of broker appends refetches once per window, so the refetch rate never tracks the append rate. */
const RELAY_COALESCE_MS = 300;

const isRelaySource = (event: string): event is RelaySource => Object.hasOwn(RELAY_INVALIDATES, event);

/**
 * Mounted once by the shell. Each source refetches its reads at most once per window, at the
 * window's end, so a steady stream still refetches; every relayed read refetches after the
 * browser's own stream reopens, since frames sent while it was down are lost.
 */
export function useRelayInvalidation(coalesceMs: number = RELAY_COALESCE_MS): void {
  const schedule = useCoalescedInvalidate(coalesceMs);
  const invalidate = useInvalidate();
  const status = useEvents((message) => {
    if (isRelaySource(message.event)) schedule(message.event);
  });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (status !== "open") return;
    if (wasOpen.current) invalidate(ALL_RELAYED_READS);
    wasOpen.current = true;
  }, [status, invalidate]);
}

/** One pending timer per source at most; cleared on unmount. */
function useCoalescedInvalidate(coalesceMs: number): (source: RelaySource) => void {
  const invalidate = useInvalidate();
  const pending = useRef(new Map<RelaySource, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = pending.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);
  return useCallback(
    (source) => {
      if (pending.current.has(source)) return;
      const fire = (): void => {
        pending.current.delete(source);
        invalidate(RELAY_INVALIDATES[source]);
      };
      pending.current.set(source, setTimeout(fire, coalesceMs));
    },
    [coalesceMs, invalidate],
  );
}
