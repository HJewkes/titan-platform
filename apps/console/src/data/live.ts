import { useCallback, useEffect, useRef } from "react";
import type { CommandName } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RelaySource } from "../../server/events-relay.js";
import { useEvents, useInvalidate } from "./rpc.js";

/** The reads each relayed source can change; a broker message never refetches active-work's reads. */
const RELAY_INVALIDATES = {
  "active-work": ["work.portfolio", "work.initiative", "work.tasks", "work.task", "work.taskMentions", "work.taskArtifacts", "graph.ego"],
  "agent-chat": ["agents.roster", "agents.graph", "agents.messages", "agents.queue"],
  // The factory names its frames `shepherd` for every workflow run, autoresearch's too, so any of them may have moved a run.
  factory: ["autoresearch.runs", "autoresearch.run", "blockers.banner"],
} as const satisfies Record<RelaySource, readonly CommandName<ConsoleCommands>[]>;

const ALL_RELAYED_READS = Object.values(RELAY_INVALIDATES).flat();

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

/**
 * The CLI withdraws rounds, and seats raise and clear blockers, from other processes no relayed stream reports, so those
 * reads refetch whenever the owner returns to the tab.
 */
const RETURN_INVALIDATES = ["rounds.list", "blockers.banner"] as const satisfies readonly CommandName<ConsoleCommands>[];

/** Mounted once by the shell: window focus, or the tab turning visible, refetches the reads only a return can catch up. */
export function useReturnInvalidation(): void {
  const invalidate = useInvalidate();
  useEffect(() => {
    const refetch = (): void => {
      if (document.visibilityState !== "hidden") invalidate(RETURN_INVALIDATES);
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [invalidate]);
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
