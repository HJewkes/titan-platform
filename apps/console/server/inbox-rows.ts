/**
 * What `inbox.list` sends the page, and the two upstream reads it keeps (TP-4390). An item carries fields the page never
 * renders and an asker may fill at any length, so a row leaves them out; planning rows open collapsed, so the default view
 * sends only their count and the page asks for them when the section opens. The factory's needs.list and Shepherd's
 * finished runs each take seconds, so the view serves a recent read of each while one refresh runs behind it. The taps
 * share the same kept needs read (TP-4754), so a prepare or an act inside the window adds no needs.list of its own.
 */
import type { OwnerItem } from "@titan-design/owner-queue";
import type { InboxItem, InboxSources, WatchRow } from "./inbox-view.js";
import type { FactoryNeeds } from "./approvals.js";
import { cachedRead, cachedReads, type CacheTimes, type CachedRead } from "./read-cache.js";
import type { LineageReader, ShipLineage } from "./ship-lineage.js";

/** Long enough that a page and its taps share one needs read, short enough that a gate answered elsewhere leaves soon. */
const INBOX_CACHE_TIMES: CacheTimes = { freshMs: 15_000, staleMs: 5 * 60_000 };
/** TP-4754: a merge row's lineage is a GitHub read per PR head, seconds on the live spool, so a row serves the kept one while it refreshes. */
const LINEAGE_TIMES: CacheTimes = { freshMs: 60_000, staleMs: 10 * 60_000 };
const LINEAGE_MAX_KEYS = 256;

type Recommendation = NonNullable<OwnerItem["recommended"]>;
type ShownRecommendation = Omit<Recommendation, "rationale" | "cite">;
type InboxRow = Omit<InboxItem, "context" | "anchors" | "pins" | "recommended"> & { recommended?: ShownRecommendation };

const shownRecommendation = ({ rationale: _rationale, cite: _cite, ...shown }: Recommendation): ShownRecommendation => shown;

export function inboxRow({ context: _context, anchors: _anchors, pins: _pins, recommended, ...row }: InboxItem): InboxRow {
  return recommended === undefined ? row : { ...row, recommended: shownRecommendation(recommended) };
}

export interface ViewRows {
  items: InboxRow[];
  /** Every planning item, whether or not `items` carries them. */
  planningCount: number;
}

export function viewRows(items: readonly InboxItem[], { planning = false }: { planning?: boolean }): ViewRows {
  const planningCount = items.filter((item) => item.section === "planning").length;
  const shown = planning ? items : items.filter((item) => item.section !== "planning");
  return { items: shown.map(inboxRow), planningCount };
}

export interface InboxReadCache {
  factory?: FactoryNeeds;
  finished: CachedRead<WatchRow[]>;
  /** Absent when the rounds source wires no GitHub reader. */
  lineage?: LineageReader;
  /** `inbox.act` calls it after a write, so the page's next read shows the answered item gone. */
  invalidate(): void;
  /** A factory frame calls it: the kept reads are still served and the next read refreshes them behind (TP-4754). */
  stale(): void;
}

/** An unknown lineage is a failed read, so it is never kept and the next row retries GitHub. */
class UnknownLineage extends Error {
  constructor(readonly lineage: ShipLineage) {
    super("lineage unknown");
  }
}

function cachedLineage(read: LineageReader, now: (() => number) | undefined): LineageReader {
  const keyOf = ({ repo, pr, headSha }: Parameters<LineageReader>[0]): string => `${repo}#${pr}@${headSha}`;
  const known: LineageReader = async (binding) => {
    const lineage = await read(binding);
    if (!lineage.known) throw new UnknownLineage(lineage);
    return lineage;
  };
  const cache = cachedReads(known, LINEAGE_TIMES, { keyOf, maxKeys: LINEAGE_MAX_KEYS, ...(now !== undefined && { now }) });
  return (binding) => cache.read(binding).catch((error: unknown) => (error instanceof UnknownLineage ? error.lineage : { known: false, reason: String(error) }));
}

export function inboxReadCache({ factory, shepherd, rounds, now }: InboxSources, times: CacheTimes = INBOX_CACHE_TIMES): InboxReadCache {
  const needs = factory === undefined ? undefined : cachedRead(() => factory.list(), times, now);
  const finished = cachedRead(() => shepherd.list("finished"), times, now);
  const lineage = rounds.lineage === undefined ? undefined : cachedLineage(rounds.lineage, now);
  return {
    ...(needs !== undefined && { factory: { list: () => needs.read() } }),
    finished,
    ...(lineage !== undefined && { lineage }),
    invalidate: () => {
      needs?.invalidate();
      finished.invalidate();
    },
    stale: () => {
      needs?.stale();
      finished.stale();
    },
  };
}
