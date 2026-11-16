import type { Logger } from "@titan-design/daemon";
import type { ActiveWork, ReadName } from "./active-work.js";
import type { RelaySource } from "./events-relay.js";

/** The whole-tree active-work reads the owner's work, tasks and inbox pages open with. */
const WHOLE_TREE_READS: ReadonlyArray<readonly [ReadName, Record<string, unknown>]> = [
  ["list", {}],
  ["inventory", {}],
  ["task.list", { all_initiatives: true }],
  ["artifact.list", { all_initiatives: true }],
];

interface KeepWarmSources {
  /** The cached client, so each read here fills the kept answer the pages are served. */
  activeWork: ActiveWork;
  /** The inbox's kept needs.list and finished runs, so each read here fills what `inbox.list` is served. */
  inbox: { factory?: { list(): Promise<unknown> }; finished: { read(): Promise<unknown> } };
  logger: Pick<Logger, "warn">;
}

interface KeepWarm {
  /** Reads every kept whole-tree answer once; never rejects. */
  prime(): Promise<void>;
  /** The upstream's stream reopened, so it may have restarted and lost its own kept reads: read this source's again. */
  reconnected(source: RelaySource): Promise<void>;
}

/**
 * TP-6703: the first page after a console or upstream restart paid every cold whole-tree read (seconds each), since nothing
 * read them until the owner did. The daemon primes them at serve start and on each reconnect, never inside the registry, so
 * a test that builds the registry reads no more than it did. A factory read also warms the factory's own kept leg.
 */
export function keepWarm({ activeWork, inbox, logger }: KeepWarmSources): KeepWarm {
  const readsOf: Record<RelaySource, () => Array<Promise<unknown> | undefined>> = {
    "active-work": () => WHOLE_TREE_READS.map(([command, args]) => activeWork.read(command, args)),
    factory: () => [inbox.factory?.list(), inbox.finished.read()],
    "agent-chat": () => [],
  };
  const warm = async (sources: readonly RelaySource[]): Promise<void> => {
    const settled = await Promise.allSettled(sources.flatMap((source) => readsOf[source]()));
    const failed = settled.filter((result) => result.status === "rejected").length;
    if (failed > 0) logger.warn({ sources, failed }, "keep-warm: reads failed; the next page read retries them");
  };
  return { prime: () => warm(["active-work", "factory"]), reconnected: (source) => warm([source]) };
}
