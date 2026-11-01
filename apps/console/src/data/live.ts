import { useCallback, useEffect, useRef } from "react";
import type { CommandName } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../../server/commands.js";
import type { RelaySource } from "../../server/events-relay.js";
import { useEvents, useInvalidate } from "./rpc.js";

/** The reads each relayed source can change; a broker message never refetches active-work's reads. */
const RELAY_INVALIDATES = {
  "active-work": ["work.portfolio", "work.initiative", "work.tasks", "work.task", "work.taskMentions", "work.taskArtifacts", "graph.ego"],
  "agent-chat": ["agents.roster", "agents.graph", "agents.messages", "agents.queue"],
  factory: ["autoresearch.runs", "autoresearch.run", "blockers.banner"],
} as const satisfies Record<RelaySource, readonly CommandName<ConsoleCommands>[]>;

/** A frame that says its run is a shepherd's leaves autoresearch's reads alone; one that says nothing, as an older factory's, may have moved either. */
const SHEPHERD_FRAME_INVALIDATES = ["blockers.banner"] as const satisfies readonly CommandName<ConsoleCommands>[];

type Read = CommandName<ConsoleCommands>;

/** The reads a frame may have changed; its data is the relay's `{ kind, ..., workflow? }`, and anything unreadable means the source's full set. */
function readsFor(source: RelaySource, data: string): readonly Read[] {
  if (source !== "factory") return RELAY_INVALIDATES[source];
  try {
    const frame: unknown = JSON.parse(data);
    const workflow = typeof frame === "object" && frame !== null ? (frame as { workflow?: unknown }).workflow : undefined;
    return workflow === "shepherd" ? SHEPHERD_FRAME_INVALIDATES : RELAY_INVALIDATES.factory;
  } catch {
    return RELAY_INVALIDATES.factory;
  }
}

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
    if (isRelaySource(message.event)) schedule(message.event, readsFor(message.event, message.data));
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

/** One pending timer per source at most, refetching the union of what its frames asked for; cleared on unmount. */
function useCoalescedInvalidate(coalesceMs: number): (source: RelaySource, reads: readonly Read[]) => void {
  const invalidate = useInvalidate();
  const pending = useRef(new Map<RelaySource, ReturnType<typeof setTimeout>>());
  const wanted = useRef(new Map<RelaySource, Set<Read>>());
  useEffect(() => {
    const timers = pending.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      wanted.current.clear();
    };
  }, []);
  return useCallback(
    (source, reads) => {
      const union = wanted.current.get(source) ?? new Set<Read>();
      reads.forEach((read) => union.add(read));
      wanted.current.set(source, union);
      if (pending.current.has(source)) return;
      const fire = (): void => {
        pending.current.delete(source);
        wanted.current.delete(source);
        invalidate([...union]);
      };
      pending.current.set(source, setTimeout(fire, coalesceMs));
    },
    [coalesceMs, invalidate],
  );
}
