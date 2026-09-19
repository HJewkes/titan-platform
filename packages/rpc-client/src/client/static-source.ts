import { EXIT, errorEnvelope, type JsonEnvelope } from "@titan-design/rpc-protocol";
import { checkedWireArgs, snapshotKey } from "./canonical-key.js";
import type { DataSource, EventHandlers, Subscription } from "./data-source.js";
import { isEnvelope } from "./envelope-shape.js";
import type { Snapshot, SnapshotResolver } from "./snapshot.js";

export interface StaticSourceOptions {
  snapshot: Snapshot;
  /** Answers calls the snapshot did not record, from `snapshot.dataset`. */
  resolve?: SnapshotResolver;
}

/** No server: recorded answers first, then the resolver, then `EXIT.UNAVAILABLE`. */
export function staticSource({ snapshot, resolve }: StaticSourceOptions): DataSource {
  return {
    async call(name, args, options) {
      options?.signal?.throwIfAborted();
      const envelope = await answer(snapshot, resolve, name, args);
      options?.signal?.throwIfAborted();
      // A copy per call, as a live daemon gives, so a caller mutating a result cannot alter the snapshot.
      return structuredClone(envelope);
    },
    subscribe: (handlers, options) => quietSubscription(handlers, options?.signal),
  };
}

async function answer(
  snapshot: Snapshot,
  resolve: SnapshotResolver | undefined,
  name: string,
  args: unknown,
): Promise<JsonEnvelope<unknown>> {
  const wire = checkedWireArgs(args);
  if (!wire.ok) return wire;
  const recorded = snapshot.calls[snapshotKey(name, wire.data)];
  if (recorded) return recorded;
  if (resolve && snapshot.dataset !== undefined) return askResolver(resolve, name, wire.data, snapshot.dataset);
  return errorEnvelope(`${name} with these args is not in this snapshot`, EXIT.UNAVAILABLE);
}

/** The resolver lives in another package, so its contract is enforced here: `call` must reject only on abort. */
async function askResolver(resolve: SnapshotResolver, name: string, args: unknown, dataset: unknown): Promise<JsonEnvelope<unknown>> {
  try {
    const envelope: unknown = await resolve(name, args, dataset);
    if (isEnvelope(envelope)) return envelope;
    return errorEnvelope(`Snapshot resolver returned no envelope for ${name}`, EXIT.SOFTWARE);
  } catch (err) {
    return errorEnvelope(`Snapshot resolver failed for ${name}: ${err instanceof Error ? err.message : String(err)}`, EXIT.SOFTWARE);
  }
}

/** A snapshot never changes, so its subscription opens and then stays quiet until closed. */
function quietSubscription(handlers: EventHandlers, signal: AbortSignal | undefined): Subscription {
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    handlers.onStatus?.("closed");
  };
  handlers.onStatus?.("open");
  if (signal?.aborted) close();
  signal?.addEventListener("abort", close, { once: true });
  return { close };
}
