import type { Logger } from "@titan-design/daemon";
import type { ActiveWork, ReadName, ReadResult } from "./active-work.js";
import { settleBounded } from "./bounded.js";
import type { RelaySource } from "./events-relay.js";
import type { GateStripReader } from "./gate-strip.js";
import type { EvidenceReader } from "./repo-evidence.js";
import type { ShepherdSource } from "./shepherd.js";
import { readEvidence } from "./tasks.js";

/**
 * TP-6748: the live active-work daemon is an old build that stalls under load, so the primer's fan-outs (one brief read per
 * initiative, one strip per active PR) share this many upstream calls in flight.
 */
const MAX_IN_FLIGHT = 6;

/** The whole-tree active-work reads the owner's work, tasks and inbox pages open with. */
const WHOLE_TREE_READS: ReadonlyArray<readonly [ReadName, Record<string, unknown>]> = [
  ["inventory", {}],
  ["task.list", { all_initiatives: true }],
  ["artifact.list", { all_initiatives: true }],
];

interface KeepWarmSources {
  /** The cached client, so each read here fills the kept answer the pages are served. */
  activeWork: ActiveWork;
  /**
   * The inbox's kept needs.list and finished runs, so each read here fills what `inbox.list` is served; `shown` reads the
   * rows the default view shows, which keeps each merge row's lineage (TP-6751).
   */
  inbox: { factory?: { list(): Promise<unknown> }; finished: { read(): Promise<unknown> }; strips: Pick<GateStripReader, "warm">; shown(): Promise<unknown> };
  /** The active runs whose gate strips the inbox opens with. */
  shepherd: Pick<ShepherdSource, "list">;
  /** `work.tasks`' kept git and GitHub evidence for every repo the artifacts name (TP-6751); absent, none is primed. */
  evidence?: EvidenceReader;
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
export function keepWarm({ activeWork, inbox, shepherd, evidence, logger }: KeepWarmSources): KeepWarm {
  /** The portfolio reads every initiative's brief for its task prefix (TP-6746), so the primer reads each into the same kept answer. */
  const briefs = async (list: ReadResult<"list">): Promise<void> => {
    const slugs = list.sections.flatMap((section) => section.items.map((item) => item.slug));
    const failed = await settleBounded(slugs, MAX_IN_FLIGHT, (slug) => activeWork.read("source.read", { slug, path: "brief.md" }));
    if (failed > 0) throw new Error(`${failed} brief reads failed`);
  };
  const strips = async (): Promise<void> => inbox.strips.warm(await shepherd.list("active"), MAX_IN_FLIGHT);
  const readsOf: Record<RelaySource, () => Array<Promise<unknown> | undefined>> = {
    "active-work": () => {
      const list = activeWork.read("list", {});
      const repos = evidence === undefined ? undefined : readEvidence(activeWork, evidence);
      return [list, list.then(briefs), ...WHOLE_TREE_READS.map(([command, args]): Promise<unknown> => activeWork.read(command, args)), repos];
    },
    factory: () => [inbox.factory?.list(), inbox.finished.read(), strips(), inbox.shown()],
    "agent-chat": () => [],
  };
  const warm = async (sources: readonly RelaySource[]): Promise<void> => {
    const settled = await Promise.allSettled(sources.flatMap((source) => readsOf[source]()));
    const failed = settled.filter((result) => result.status === "rejected").length;
    if (failed > 0) logger.warn({ sources, failed }, "keep-warm: reads failed; the next page read retries them");
  };
  return { prime: () => warm(["active-work", "factory"]), reconnected: (source) => warm([source]) };
}
